import * as vscode from 'vscode';
import type { BlindspotConfig } from '../core/config';
import { LineLedger, hasEvidence, type StoredLine } from '../core/ledger';
import { isIgnored } from '../core/coverage';
import { attentionNorm, focusLine } from '../core/attention';
import { emptyActivity, type ActivityCounts, type LineEvidence, type Provenance } from '../core/types';
import { STATE_VERSION, isForgotten, type AiRegions, type BlindspotState } from '../core/store';
import { relativeKey } from './paths';

const TICK_MS = 250;
/**
 * Ignore any tick longer than this. A laptop lid closing, a debugger pause, or
 * a suspended machine would otherwise credit hours of "reading time" to
 * whatever happened to be on screen — the single easiest way to make this tool
 * lie to you.
 */
const MAX_TICK_MS = 2000;
/** Two hover requests on one line inside this window are one rest, not two. */
const POINTER_DEBOUNCE_MS = 750;

interface ViewState {
  signature: string;
  stationarySince: number;
  dwellCredited: boolean;
  topLine: number;
}

/**
 * Collects attention evidence from the editor.
 *
 * The rules it enforces, in order of how much they matter:
 *  - nothing counts while the window is not focused
 *  - nothing counts while the viewport is moving faster than a human reads
 *  - "on screen" and "read" are different things, and only the scoring model
 *    in core/ decides where the line between them is
 */
export class AttentionTracker implements vscode.Disposable {
  private readonly ledgers = new Map<string, LineLedger>();
  private readonly views = new Map<string, ViewState>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastTick = Date.now();
  private windowFocused = vscode.window.state.focused;
  private suppressCaretUntil = 0;
  private dirty = false;
  private trackedMs = 0;
  private activity: ActivityCounts = emptyActivity();
  /** Last caret move, scroll, hover or edit. Screen time past `idleAfterMs` from here is idling. */
  private lastActivity = Date.now();
  private baseline: BlindspotState['baseline'] = null;
  /** Paths the reader has told us not to measure. See `store.ts`. */
  private ignored: string[] = [];
  /**
   * Where the mouse last came to rest, from the editor's hover requests. The
   * caret is where the last keyboard act happened; the pointer is where the
   * last mouse act happened; whichever is more recent is the better guess at
   * where the eyes are. A scroll invalidates it: the lines under a still
   * mouse have moved, and nothing says which line it is on now.
   */
  private pointer: { key: string; line: number; at: number } | null = null;
  /** When the caret last moved in each document, to compare against the pointer. */
  private readonly caretMovedAt = new Map<string, number>();

  constructor(
    private readonly ctx: { root: string },
    private cfg: BlindspotConfig,
    private aiRegions: AiRegions,
    private readonly onDirty: () => void,
  ) {}

  start(state: BlindspotState): void {
    this.trackedMs = state.trackedMs;
    this.activity = { ...state.activity };
    this.baseline = state.baseline;
    this.ignored = [...state.ignored];
    for (const [file, lines] of Object.entries(state.files)) {
      this.pending.set(file, lines);
    }

    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        this.windowFocused = s.focused;
        // Coming back from another app should not be treated as a long pause
        // spent reading whatever is on screen.
        this.lastTick = Date.now();
        this.lastActivity = this.lastTick;
        if (!s.focused) this.views.clear();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.views.clear()),
      vscode.workspace.onDidCloseTextDocument((doc) => this.views.delete(this.viewKey(doc))),
      vscode.workspace.onDidRenameFiles((e) => this.onRenamed(e)),
    );

    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  updateConfig(cfg: BlindspotConfig, aiRegions: AiRegions): void {
    this.cfg = cfg;
    this.aiRegions = aiRegions;
  }

  // ------------------------------------------------------------------- state

  /** Evidence loaded from disk but not yet anchored to an open document. */
  private readonly pending = new Map<string, StoredLine[]>();

  private key(doc: vscode.TextDocument): string | null {
    const rel = this.relKey(doc.uri);
    if (!rel || isIgnored(rel, this.cfg.ignore)) return null;
    // A file the reader has forgotten stays forgotten while it is open, or the
    // next tick would put it straight back into the denominator.
    if (isForgotten(this.ignored, rel)) return null;
    return rel;
  }

  /** Repo-relative key for a URI, or null when it is not a file in this repository. */
  private relKey(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') return null;
    return relativeKey(this.ctx.root, uri.fsPath);
  }

  private viewKey(doc: vscode.TextDocument): string {
    return doc.uri.toString();
  }

  /**
   * Ledger for a document, anchoring persisted evidence on first touch. A
   * ledger that already exists is returned as is — unless evidence has since
   * arrived under this name, which a rename does, in which case it is anchored
   * to the text and folded in.
   */
  private ledgerFor(doc: vscode.TextDocument, file: string): LineLedger {
    let ledger = this.ledgers.get(file);
    if (ledger && !this.pending.has(file)) return ledger;

    const stored = this.pending.get(file);
    this.pending.delete(file);
    const textLines = docLines(doc);
    if (ledger) {
      if (stored) ledger.mergeFrom(LineLedger.anchor(stored, textLines));
      return ledger;
    }
    ledger = stored ? LineLedger.anchor(stored, textLines) : new LineLedger();
    ledger.resize(doc.lineCount);
    this.applyDeclaredAi(ledger, file);
    this.ledgers.set(file, ledger);
    return ledger;
  }

  private onRenamed(e: vscode.FileRenameEvent): void {
    for (const { oldUri, newUri } of e.files) {
      const from = this.relKey(oldUri);
      const to = this.relKey(newUri);
      if (from && to) this.followRename(from, to);
    }
  }

  /**
   * A file or folder changed its name. Its lines did not, and the evidence is
   * about the lines, so it moves with them. Without this a renamed file came
   * back entirely unread — evidence is keyed by path, and Reading mode lost
   * the file altogether, however long had been spent in it.
   */
  followRename(from: string, to: string): void {
    if (from === to) return;
    for (const key of this.files()) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.moveKey(key, to + key.slice(from.length));
    }
  }

  private moveKey(from: string, to: string): void {
    const ledger = this.ledgers.get(from);
    const stored = this.pending.get(from);
    if (!ledger && !stored) return;
    this.ledgers.delete(from);
    this.pending.delete(from);
    if (ledger) {
      const existing = this.ledgers.get(to);
      if (existing) existing.mergeFrom(ledger);
      else this.ledgers.set(to, ledger);
    }
    if (stored && stored.length > 0) {
      // Reading done under the new name comes first, so it anchors ahead of
      // the old. If the new name is already open this waits in `pending`:
      // the next touch anchors it, and a snapshot in between carries it as is.
      const own = this.pending.get(to);
      this.pending.set(to, own ? [...own, ...stored] : stored);
    }
    this.markDirty();
  }

  private applyDeclaredAi(ledger: LineLedger, file: string): void {
    const regions = this.aiRegions[file];
    if (!regions) return;
    for (const [start, end] of regions) {
      ledger.setProvenance(start, Math.max(start, end), 'declared-ai');
    }
  }

  // -------------------------------------------------------------------- tick

  private tick(): void {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (dt <= 0 || dt > MAX_TICK_MS) return;
    if (!this.windowFocused) return;
    // Nothing has moved for a long time. A file left on screen while you are
    // in a meeting is not reading, and it is certainly not focus. A scroll
    // ends it, so the viewports are still inspected below; only credit stops.
    let idle = now - this.lastActivity > this.cfg.idleAfterMs;
    let counted = false;

    const active = vscode.window.activeTextEditor;

    for (const editor of vscode.window.visibleTextEditors) {
      const file = this.key(editor.document);
      if (!file) continue;
      const ledger = this.ledgerFor(editor.document, file);
      const ranges = editor.visibleRanges;
      if (ranges.length === 0) continue;

      const vk = `${this.viewKey(editor.document)}#${editor.viewColumn ?? 0}`;
      const signature = ranges.map((r) => `${r.start.line}:${r.end.line}`).join(',');
      const topLine = ranges[0].start.line;
      const prev = this.views.get(vk);

      let scrollSpeed = 0;
      if (prev) scrollSpeed = (Math.abs(topLine - prev.topLine) * 1000) / dt;

      if (prev && prev.signature !== signature) {
        this.lastActivity = now;
        idle = false;
        // The text moved under the mouse; its last known line is stale.
        if (this.pointer?.key === this.viewKey(editor.document)) this.pointer = null;
      }
      const view: ViewState =
        prev && prev.signature === signature
          ? prev
          : { signature, stationarySince: now, dwellCredited: false, topLine };
      view.topLine = topLine;
      this.views.set(vk, view);

      const tooFast = this.cfg.readingSpeedGuard && scrollSpeed > this.cfg.maxLinesPerSecond;
      if (tooFast || idle) continue;
      if (!counted) {
        this.trackedMs += dt;
        counted = true;
      }

      const isActive = active?.document === editor.document && active.viewColumn === editor.viewColumn;
      // Where attention plausibly sits inside this viewport. Without an eye
      // tracker the editor knows two things about it: where the caret is and
      // where the mouse last stopped. The more recent act wins, so reading
      // with the mouse while the caret sits at the top of the file credits
      // the lines under the mouse, not the ones under the caret.
      const first = ranges[0].start.line + 1;
      const last = ranges[ranges.length - 1].end.line + 1;
      const focusAt = focusLine(this.focusCandidate(editor, now), first, last);
      const focus = {
        line: focusAt,
        norm: attentionNorm(
          ranges.map((r) => [r.start.line + 1, r.end.line + 1] as [number, number]),
          focusAt,
          this.cfg,
        ),
        cfg: this.cfg,
      };
      for (const r of ranges) {
        ledger.addVisible(r.start.line + 1, r.end.line + 1, dt, isActive, now, focus);
      }

      if (!view.dwellCredited && now - view.stationarySince >= this.cfg.dwellMs && isActive) {
        for (const r of ranges) {
          ledger.addDwell(r.start.line + 1, r.end.line + 1, now, focus);
        }
        view.dwellCredited = true;
      }
      this.markDirty();
    }
  }

  // ------------------------------------------------------------------ events

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.windowFocused) return;
    // Our own "jump to next blindspot" must not mark the blindspot as read.
    if (Date.now() < this.suppressCaretUntil) return;
    const file = this.key(e.textEditor.document);
    if (!file) return;
    const ledger = this.ledgerFor(e.textEditor.document, file);
    const now = Date.now();
    this.lastActivity = now;
    this.caretMovedAt.set(this.viewKey(e.textEditor.document), now);
    this.activity.navigations += 1;
    for (const sel of e.selections) {
      ledger.addCaret(sel.start.line + 1, sel.end.line + 1, now);
    }
    this.markDirty();
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    const file = this.key(e.document);
    if (!file) return;
    if (e.contentChanges.length === 0) return;
    const ledger = this.ledgerFor(e.document, file);
    const now = Date.now();
    this.lastActivity = now;
    const undoRedo =
      e.reason === vscode.TextDocumentChangeReason.Undo ||
      e.reason === vscode.TextDocumentChangeReason.Redo;

    // Apply bottom-up so a splice never shifts a range we have not used yet.
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    for (const c of changes) {
      const newLineCount = countLines(c.text);
      const bulk =
        !undoRedo &&
        (c.text.length >= this.cfg.bulkInsertChars || newLineCount >= this.cfg.bulkInsertLines);
      const provenance: Provenance = bulk ? 'bulk' : undoRedo ? 'unknown' : 'typed';
      ledger.applyChange(c.range.start.line + 1, c.range.end.line + 1, newLineCount, {
        human: !bulk && !undoRedo,
        provenance,
        now,
      });
    }
    ledger.resize(e.document.lineCount);
    if (!undoRedo && changes.some((c) => c.text.length < this.cfg.bulkInsertChars)) {
      this.activity.edits += 1;
    }
    this.markDirty();
  }

  /**
   * The line the reader's attention most plausibly sits on: the mouse if it
   * came to rest more recently than the caret moved and is still on screen,
   * otherwise the caret. `focusLine` handles the caret being scrolled away.
   */
  private focusCandidate(editor: vscode.TextEditor, now: number): number {
    const caretLine = editor.selection.active.line + 1;
    const p = this.pointer;
    if (!p || p.key !== this.viewKey(editor.document)) return caretLine;
    if (now - p.at > this.cfg.idleAfterMs) return caretLine;
    if (p.at < (this.caretMovedAt.get(p.key) ?? 0)) return caretLine;
    const onScreen = editor.visibleRanges.some(
      (r) => p.line >= r.start.line + 1 && p.line <= r.end.line + 1,
    );
    return onScreen ? p.line : caretLine;
  }

  /**
   * The mouse stopped over a line. VS Code reports it by asking hover
   * providers for content, which is the only place the API lets slip where
   * the pointer is. Counted as a navigation hit on the line, and adopted as
   * the focus of the attention budget while it is the most recent act.
   */
  notePointer(doc: vscode.TextDocument, line: number): void {
    if (!this.windowFocused) return;
    const file = this.key(doc);
    if (!file) return;
    const now = Date.now();
    const key = this.viewKey(doc);
    const prev = this.pointer;
    this.pointer = { key, line, at: now };
    this.lastActivity = now;
    if (prev && prev.key === key && prev.line === line && now - prev.at < POINTER_DEBOUNCE_MS) return;
    this.ledgerFor(doc, file).addPointer(line, now);
    this.activity.navigations += 1;
    this.markDirty();
  }

  /** A review action that is not a caret move or an edit. */
  recordActivity(kind: 'jumps' | 'marks' | 'completions'): void {
    this.activity[kind] += 1;
    this.lastActivity = Date.now();
    this.markDirty();
  }

  get activityCounts(): ActivityCounts {
    return this.activity;
  }

  get reviewBaseline(): BlindspotState['baseline'] {
    return this.baseline;
  }

  setBaseline(commit: string, now = Date.now()): void {
    this.baseline = { commit, setAt: now };
    this.recordActivity('completions');
  }

  /** Every file with evidence, open or persisted. What general reading measures. */
  files(): string[] {
    return [...new Set([...this.ledgers.keys(), ...this.pending.keys()])];
  }

  // ------------------------------------------------------------------ queries

  /** Suppress caret credit briefly, while we move the cursor ourselves. */
  suppressCaretCredit(ms = 400): void {
    this.suppressCaretUntil = Date.now() + ms;
  }

  getEvidence(file: string, line: number): LineEvidence | undefined {
    const ledger = this.ledgers.get(file);
    if (ledger) return ledger.peek(line);
    // Not open in the editor: fall back to persisted evidence, positionally.
    // Hash anchoring needs the document text, so the caller supplies it via
    // `primeFromText` when it has one.
    return undefined;
  }

  /**
   * Anchor persisted evidence for a file that is not open in the editor, using
   * text the caller already has (the report builder reads the working tree
   * anyway). Without this, closing a tab would erase your review history from
   * the report even though it is still on disk.
   */
  primeFromText(file: string, textLines: string[]): void {
    const stored = this.pending.get(file);
    if (!stored) return;
    this.pending.delete(file);
    const anchored = LineLedger.anchor(stored, textLines);
    const existing = this.ledgers.get(file);
    if (existing) {
      // Evidence that reached this name after its ledger existed: a rename.
      existing.mergeFrom(anchored);
      return;
    }
    this.applyDeclaredAi(anchored, file);
    this.ledgers.set(file, anchored);
  }

  /** Explicit user override: "I reviewed this elsewhere." */
  markReviewed(file: string, lineCount: number): void {
    const ledger = this.ledgers.get(file) ?? new LineLedger();
    this.ledgers.set(file, ledger);
    ledger.resize(Math.max(ledger.length, lineCount));
    const now = Date.now();
    // Enough focused time to pass the read acknowledgement at any line cost.
    const readMs = Math.max(this.cfg.focusedMsForPoint, this.cfg.readAckMs * this.cfg.maxReadCost);
    for (let l = 1; l <= Math.max(ledger.length, lineCount); l++) {
      const ev = ledger.at(l);
      ev.visibleMs = Math.max(ev.visibleMs, this.cfg.visibleMsForPoint);
      ev.focusedMs = Math.max(ev.focusedMs, readMs);
      ev.dwellEvents = Math.max(ev.dwellEvents, 1);
      ev.caretHits = Math.max(ev.caretHits, 1);
      ev.revisits = Math.max(ev.revisits, this.cfg.revisitsForPoint);
      ev.lastSeen = now;
    }
    this.activity.marks += 1;
    this.markDirty();
  }

  /**
   * Drop everything recorded for a file, or for a folder and all of it, and
   * return what went.
   *
   * Reading mode measures every file with evidence, so one vendored file
   * opened by accident stays in the denominator for a month. This is the way
   * back out, and it is honest about what it does: the evidence is deleted,
   * not hidden, so the file simply has not been read here.
   */
  forget(target: string): string[] {
    const prefix = target.replace(/\/+$/, '');
    const gone: string[] = [];
    for (const file of this.files()) {
      if (file !== prefix && !file.startsWith(`${prefix}/`)) continue;
      this.ledgers.delete(file);
      this.pending.delete(file);
      gone.push(file);
    }
    this.ignored = [
      ...new Set([...this.ignored.filter((p) => p !== prefix && !p.startsWith(`${prefix}/`)), prefix]),
    ].sort();
    this.markDirty();
    return gone.sort();
  }

  /** Undo a `forget`: measure this path again from now on. */
  measureAgain(target: string): boolean {
    const prefix = target.replace(/\/+$/, '');
    const next = this.ignored.filter((p) => p !== prefix && !p.startsWith(`${prefix}/`));
    if (next.length === this.ignored.length) return false;
    this.ignored = next;
    this.markDirty();
    return true;
  }

  /** What the reader has asked not to be measured. */
  get forgotten(): readonly string[] {
    return this.ignored;
  }

  reset(): void {
    this.ledgers.clear();
    this.pending.clear();
    this.views.clear();
    this.trackedMs = 0;
    this.activity = emptyActivity();
    this.baseline = null;
    this.ignored = [];
    this.markDirty();
  }

  /** Serialize open ledgers plus untouched persisted evidence. */
  snapshot(textFor: (file: string) => string[] | undefined): BlindspotState {
    const files: Record<string, StoredLine[]> = {};
    for (const [file, stored] of this.pending) {
      if (stored.length > 0) files[file] = stored;
    }
    for (const [file, ledger] of this.ledgers) {
      const textLines = textFor(file);
      if (!textLines) continue;
      const serialized = ledger.serialize(textLines);
      // Evidence a rename moved here that nothing has anchored yet rides
      // along behind the ledger's own, rather than being overwritten by it.
      const carried = files[file] ?? [];
      if (serialized.length + carried.length > 0) files[file] = [...serialized, ...carried];
    }
    return {
      version: STATE_VERSION,
      updatedAt: Date.now(),
      files,
      trackedMs: this.trackedMs,
      activity: { ...this.activity },
      baseline: this.baseline,
      ignored: [...this.ignored],
    };
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.onDirty();
    }
  }
}

export function docLines(doc: vscode.TextDocument): string[] {
  const out: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) out.push(doc.lineAt(i).text);
  return out;
}

export function countLines(text: string): number {
  if (text.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export { hasEvidence };
