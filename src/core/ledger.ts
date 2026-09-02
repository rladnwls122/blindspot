import { emptyEvidence, type LineEvidence, type Provenance } from './types';
import { mergeEvidence, strongerProvenance } from './evidence';
import { attentionShare, focalWeight, type FocalContext } from './attention';
import { hashLine } from './hash';

export interface StoredLine {
  /** Content hash. */
  h: string;
  /** 0-based line index the evidence was recorded at, used to break ties
   *  between identical lines when re-anchoring. Without it, a file full of
   *  `}` would hand your review credit to whichever brace came first. */
  i: number;
  /** Evidence, in the compact on-disk shape. */
  e: LineEvidence;
}

/**
 * Per-file review evidence with a live line index.
 *
 * Two jobs:
 *  1. keep evidence attached to the right line while the document is edited
 *     (`applyChange`, driven by the editor's content-change events), and
 *  2. re-attach evidence to a document that changed while we weren't looking
 *     (`anchor`, driven by content hashes on load).
 */
export class LineLedger {
  private lines: LineEvidence[] = [];

  constructor(initial: LineEvidence[] = []) {
    this.lines = initial;
  }

  get length(): number {
    return this.lines.length;
  }

  /** 1-based. Returns a live reference; callers may mutate it. */
  at(line: number): LineEvidence {
    const i = line - 1;
    if (i < 0) return emptyEvidence();
    this.grow(line);
    return this.lines[i];
  }

  /** 1-based, read-only. Never allocates for out-of-range lines. */
  peek(line: number): LineEvidence | undefined {
    return this.lines[line - 1];
  }

  all(): readonly LineEvidence[] {
    return this.lines;
  }

  private grow(toLine: number): void {
    while (this.lines.length < toLine) this.lines.push(emptyEvidence());
  }

  /** Trim or extend so the ledger matches a document of `lineCount` lines. */
  resize(lineCount: number): void {
    if (lineCount < this.lines.length) this.lines.length = Math.max(0, lineCount);
    else this.grow(lineCount);
  }

  // ---------------------------------------------------------------- crediting

/**
   * Credit one tick of screen time.
   *
   * With a `focus`, each line receives the share of the tick its distance from
   * the reader's focus makes plausible (see `core/attention.ts`); without one
   * the tick is spread flat, which is the older viewport model and what the
   * replay harness uses when it wants to isolate a single variable.
   *
   * The same pass detects re-reading: a line that was last seen longer ago
   * than `revisitGapMs` is coming back in a new viewing episode, and `lastSeen`
   * already carries everything needed to notice that.
   */
  addVisible(
    startLine: number,
    endLine: number,
    ms: number,
    focused: boolean,
    now: number,
    focus?: FocalContext,
  ): void {
    this.grow(endLine);
    const gap = focus?.cfg.revisitGapMs ?? 0;
    for (let l = startLine; l <= endLine; l++) {
      const ev = this.lines[l - 1];
      if (!ev) continue;
      const weight = focus ? focalWeight(l, focus.line, focus.cfg) : 1;
      if (weight <= 0) continue;
      if (gap > 0 && ev.lastSeen !== null && now - ev.lastSeen >= gap) ev.revisits += 1;
      // Exposure is per line: every line on screen was on screen. Attention
      // is a budget: the tick's time is shared out, not handed to each line.
      ev.visibleMs += ms * weight;
      if (focused) ev.focusedMs += ms * (focus ? attentionShare(l, focus) : 1);
      ev.lastSeen = now;
    }
  }

  /**
   * Credit a pause. With a `focus`, only lines near enough to it to have been
   * inside the reader's perceptual span are credited — a stationary viewport
   * is evidence that you stopped somewhere, not that you stopped everywhere.
   */
  addDwell(startLine: number, endLine: number, now: number, focus?: FocalContext): void {
    this.grow(endLine);
    for (let l = startLine; l <= endLine; l++) {
      const ev = this.lines[l - 1];
      if (!ev) continue;
      if (focus && focalWeight(l, focus.line, focus.cfg) < focus.cfg.dwellFocalMin) continue;
      ev.dwellEvents += 1;
      ev.lastSeen = now;
    }
  }

  addCaret(startLine: number, endLine: number, now: number): void {
    this.grow(endLine);
    for (let l = startLine; l <= endLine; l++) {
      const ev = this.lines[l - 1];
      if (!ev) continue;
      ev.caretHits += 1;
      ev.lastSeen = now;
    }
  }

  setProvenance(startLine: number, endLine: number, p: Provenance): void {
    this.grow(endLine);
    for (let l = startLine; l <= endLine; l++) {
      const ev = this.lines[l - 1];
      if (!ev) continue;
      ev.provenance = strongerProvenance(ev.provenance, p);
    }
  }

  // ------------------------------------------------------------------ editing

  /**
   * Apply one content change.
   *
   * `startLine`/`endLine` are 1-based, inclusive, in the *pre-edit* document;
   * `newLineCount` is how many lines the replacement text occupies.
   *
   * Semantics that matter:
   *  - Lines fully inside a replaced range are gone; their evidence dies with
   *    them. Keeping it would credit you for reading text that no longer exists.
   *  - The first line of the range survives (an edit usually starts mid-line),
   *    but its *visibility* evidence is reset: the content changed, so old eye
   *    time was spent on different text. The edit itself is recorded instead.
   *  - Lines below the range shift by the line delta, keeping their evidence.
   */
  applyChange(
    startLine: number,
    endLine: number,
    newLineCount: number,
    opts: { human: boolean; provenance: Provenance; now: number },
  ): void {
    this.grow(endLine);
    const start = Math.max(1, startLine);
    const end = Math.max(start, endLine);
    const oldCount = end - start + 1;
    const newCount = Math.max(1, newLineCount);

    const head = this.lines[start - 1] ?? emptyEvidence();
    // Content under the caret changed: eye-time on the old text no longer
    // vouches for the new text.
    const rewritten: LineEvidence = {
      visibleMs: 0,
      focusedMs: 0,
      dwellEvents: 0,
      caretHits: head.caretHits,
      humanEdits: head.humanEdits + (opts.human ? 1 : 0),
      revisits: 0,
      provenance: opts.human
        ? strongerProvenance(head.provenance, opts.provenance)
        : opts.provenance,
      lastSeen: opts.now,
    };

    const replacement: LineEvidence[] = [rewritten];
    for (let i = 1; i < newCount; i++) {
      const ev = emptyEvidence(opts.provenance);
      ev.humanEdits = opts.human ? 1 : 0;
      ev.lastSeen = opts.now;
      replacement.push(ev);
    }

    this.lines.splice(start - 1, oldCount, ...replacement);
  }

  // ---------------------------------------------------------------- anchoring

  /** Serialize against the current document text. */
  serialize(textLines: string[]): StoredLine[] {
    const out: StoredLine[] = [];
    const n = Math.min(textLines.length, this.lines.length);
    for (let i = 0; i < n; i++) {
      const ev = this.lines[i];
      if (!hasEvidence(ev)) continue;
      out.push({ h: hashLine(textLines[i]), i, e: ev });
    }
    return out;
  }

  /**
   * Rebuild a ledger for `textLines` from stored `(hash, index, evidence)`
   * triples.
   *
   * Matching runs per hash group rather than per line, because identical lines
   * are common (`}`, `});`, blank lines) and the first one in the file is
   * almost never the one you actually read. Within a group, each stored entry
   * claims the unconsumed current line closest to where it used to be,
   * preferring lines at or after the previous match so a block that shifted
   * down stays in order.
   *
   * A block that moved elsewhere in the file still matches, because reading
   * code and then moving it does not make it unread. Lines nothing claims start
   * with no evidence, which is the safe direction to fail: Blindspot should
   * only ever ask you to read something again.
   */
  static anchor(stored: StoredLine[], textLines: string[]): LineLedger {
    const lines: LineEvidence[] = textLines.map(() => emptyEvidence());

    const byHash = new Map<string, number[]>();
    textLines.forEach((text, idx) => {
      const h = hashLine(text);
      const bucket = byHash.get(h);
      if (bucket) bucket.push(idx);
      else byHash.set(h, [idx]);
    });

    const consumed = new Set<number>();
    let lastAssigned = -1;

    // Stored entries are written in file order, so walking them in order keeps
    // the "at or after the previous match" preference meaningful.
    for (const entry of [...stored].sort((a, b) => (a.i ?? 0) - (b.i ?? 0))) {
      const candidates = byHash.get(entry.h);
      if (!candidates) continue;

      const origin = entry.i ?? 0;
      let chosen = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      let fallback = -1;
      let fallbackDistance = Number.POSITIVE_INFINITY;

      for (const idx of candidates) {
        if (consumed.has(idx)) continue;
        const distance = Math.abs(idx - origin);
        if (idx >= lastAssigned) {
          if (distance < bestDistance) {
            bestDistance = distance;
            chosen = idx;
          }
        } else if (distance < fallbackDistance) {
          fallbackDistance = distance;
          fallback = idx;
        }
      }

      const target = chosen >= 0 ? chosen : fallback;
      if (target < 0) continue;

      consumed.add(target);
      lastAssigned = target;
      lines[target] = { ...entry.e };
    }

    return new LineLedger(lines);
  }

  /** Fold another ledger's evidence into this one, line for line. */
  mergeFrom(other: LineLedger): void {
    this.grow(other.length);
    for (let i = 0; i < other.length; i++) {
      const b = other.all()[i];
      if (!b || !hasEvidence(b)) continue;
      this.lines[i] = mergeEvidence(this.lines[i] ?? emptyEvidence(), b);
    }
  }
}

export function hasEvidence(ev: LineEvidence | undefined): boolean {
  if (!ev) return false;
  return (
    ev.visibleMs > 0 ||
    ev.focusedMs > 0 ||
    ev.dwellEvents > 0 ||
    ev.caretHits > 0 ||
    ev.humanEdits > 0 ||
    (ev.revisits ?? 0) > 0 ||
    ev.provenance !== 'unknown'
  );
}
