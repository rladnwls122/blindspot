import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlindspotConfig } from '../core/config';
import { LineLedger, hasEvidence, type StoredLine } from '../core/ledger';
import { isIgnored } from '../core/coverage';
import type { LineEvidence, Provenance } from '../core/types';
import type { AiRegions, BlindspotState } from '../core/store';
import type { GitContext } from './git';

const TICK_MS = 250;
/**
 * Ignore any tick longer than this. A laptop lid closing, a debugger pause, or
 * a suspended machine would otherwise credit hours of "reading time" to
 * whatever happened to be on screen — the single easiest way to make this tool
 * lie to you.
 */
const MAX_TICK_MS = 2000;

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

  constructor(
    private readonly ctx: GitContext,
    private cfg: BlindspotConfig,
    private aiRegions: AiRegions,
    private readonly onDirty: () => void,
  ) {}

  start(state: BlindspotState): void {
    this.trackedMs = state.trackedMs;
    for (const [file, lines] of Object.entries(state.files)) {
      this.pending.set(file, lines);
    }

    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        this.windowFocused = s.focused;
        // Coming back from another app should not be treated as a long pause
        // spent reading whatever is on screen.
        this.lastTick = Date.now();
        if (!s.focused) this.views.clear();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.views.clear()),
      vscode.workspace.onDidCloseTextDocument((doc) => this.views.delete(this.viewKey(doc))),
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
    if (doc.uri.scheme !== 'file') return null;
    const rel = path.relative(this.ctx.root, doc.uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return null;
    if (isIgnored(rel, this.cfg.ignore)) return null;
    return rel;
  }

  private viewKey(doc: vscode.TextDocument): string {
    return doc.uri.toString();
  }

  /** Ledger for a document, anchoring persisted evidence on first touch. */
  private ledgerFor(doc: vscode.TextDocument, file: string): LineLedger {
    let ledger = this.ledgers.get(file);
    if (ledger) return ledger;

    const stored = this.pending.get(file);
    const textLines = docLines(doc);
    ledger = stored ? LineLedger.anchor(stored, textLines) : new LineLedger();
    ledger.resize(doc.lineCount);
    this.pending.delete(file);
    this.applyDeclaredAi(ledger, file);
    this.ledgers.set(file, ledger);
    return ledger;
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

    this.trackedMs += dt;
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

      const view: ViewState =
        prev && prev.signature === signature
          ? prev
          : { signature, stationarySince: now, dwellCredited: false, topLine };
      view.topLine = topLine;
      this.views.set(vk, view);

      const tooFast = this.cfg.readingSpeedGuard && scrollSpeed > this.cfg.maxLinesPerSecond;
      if (tooFast) continue;

      const isActive = active?.document === editor.document && active.viewColumn === editor.viewColumn;
      for (const r of ranges) {
        ledger.addVisible(r.start.line + 1, r.end.line + 1, dt, isActive, now);
      }

      if (!view.dwellCredited && now - view.stationarySince >= this.cfg.dwellMs && isActive) {
        for (const r of ranges) {
          ledger.addDwell(r.start.line + 1, r.end.line + 1, now);
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
    this.markDirty();
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
    if (this.ledgers.has(file)) return;
    const stored = this.pending.get(file);
    if (!stored) return;
    const ledger = LineLedger.anchor(stored, textLines);
    this.applyDeclaredAi(ledger, file);
    this.ledgers.set(file, ledger);
    this.pending.delete(file);
  }

  /** Explicit user override: "I reviewed this elsewhere." */
  markReviewed(file: string, lineCount: number): void {
    const ledger = this.ledgers.get(file) ?? new LineLedger();
    this.ledgers.set(file, ledger);
    ledger.resize(Math.max(ledger.length, lineCount));
    const now = Date.now();
    for (let l = 1; l <= Math.max(ledger.length, lineCount); l++) {
      const ev = ledger.at(l);
      ev.visibleMs = Math.max(ev.visibleMs, this.cfg.visibleMsForPoint);
      ev.focusedMs = Math.max(ev.focusedMs, this.cfg.focusedMsForPoint);
      ev.dwellEvents = Math.max(ev.dwellEvents, 1);
      ev.caretHits = Math.max(ev.caretHits, 1);
      ev.lastSeen = now;
    }
    this.markDirty();
  }

  reset(): void {
    this.ledgers.clear();
    this.pending.clear();
    this.views.clear();
    this.trackedMs = 0;
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
      if (serialized.length > 0) files[file] = serialized;
    }
    return { version: 1, updatedAt: Date.now(), files, trackedMs: this.trackedMs };
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
