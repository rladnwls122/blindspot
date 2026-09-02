import { maxPoints, type BlindspotConfig } from './config';
import { readCost } from './attention';
import type { EvidenceSignals, LineEvidence, Provenance } from './types';

/**
 * Turn raw observations into the six booleans, then into points.
 *
 * The whole research question of this project lives in this function. It is
 * deliberately small, deliberately explainable, and deliberately separate from
 * the code that collects the evidence — so that the definition of "read" can be
 * changed and replayed without recollecting anything.
 *
 * `lineText` is optional and only affects the two time thresholds: a line
 * carrying more tokens needs proportionally more time before it counts as
 * seen. Omitting it evaluates the line at average cost, which is what the
 * historical flat model did.
 */
export function evaluate(
  ev: LineEvidence,
  cfg: BlindspotConfig,
  lineText?: string,
): EvidenceSignals {
  const cost = lineText === undefined ? 1 : readCost(lineText, cfg);
  const visible = ev.visibleMs >= cfg.visibleMsForPoint * cost;
  const focused = ev.focusedMs >= cfg.focusedMsForPoint * cost;
  const dwell = ev.dwellEvents > 0;
  const caret = ev.caretHits > 0;
  const edited = ev.humanEdits > 0;
  // A revisit only counts on top of real focused time. Otherwise a file left
  // open in a background split would earn re-reading credit for being scrolled
  // past twice.
  const revisit = focused && (ev.revisits ?? 0) >= cfg.revisitsForPoint;

  const w = cfg.weights;
  const points =
    (visible ? w.visible : 0) +
    (focused ? w.focused : 0) +
    (dwell ? w.dwell : 0) +
    (caret ? w.caret : 0) +
    (edited ? w.edited : 0) +
    (revisit ? w.revisit : 0);

  const max = maxPoints(w);
  const read = readFraction(ev, cfg, lineText);
  return {
    visible,
    focused,
    dwell,
    caret,
    edited,
    revisit,
    points,
    confidence: max > 0 ? Math.min(1, points / max) : 0,
    readFraction: read,
    focusFraction: focusFraction(ev, cfg, lineText),
    // The signals say *how* a line was read; the time says *whether* it was.
    // Writing a line by hand is the one signal that vouches on its own.
    reviewed: points >= cfg.reviewThresholdPoints && (edited || read >= 1),
  };
}

/**
 * How much of a line has been read, in [0,1]: focused time against the
 * acknowledgement time for a line of its cost. Grows linearly, so half the
 * time is half a read — never a full read for a glance.
 */
export function readFraction(ev: LineEvidence, cfg: BlindspotConfig, lineText?: string): number {
  const cost = lineText === undefined ? 1 : readCost(lineText, cfg);
  const need = Math.max(1, cfg.readAckMs * cost);
  return Math.min(1, ev.focusedMs / need);
}

/**
 * How focused the reading of a line was, in [0,1]: the same time, measured
 * against a higher ceiling. Beyond `focusCapMs` more time is idling, not
 * focus, and earns nothing.
 */
export function focusFraction(ev: LineEvidence, cfg: BlindspotConfig, lineText?: string): number {
  const cost = lineText === undefined ? 1 : readCost(lineText, cfg);
  const cap = Math.max(1, cfg.focusCapMs * cost);
  return Math.min(1, ev.focusedMs / cap);
}

/** Human-readable explanation of a verdict, for tooltips and the CLI. */
export function explain(ev: LineEvidence, cfg: BlindspotConfig, lineText?: string): string {
  const s = evaluate(ev, cfg, lineText);
  const parts: string[] = [];
  parts.push(`${s.visible ? '✓' : '·'} on screen (${Math.round(ev.visibleMs)}ms)`);
  parts.push(`${s.focused ? '✓' : '·'} focused (${Math.round(ev.focusedMs)}ms)`);
  parts.push(`${s.dwell ? '✓' : '·'} paused (${ev.dwellEvents}×)`);
  parts.push(`${s.caret ? '✓' : '·'} navigated (${ev.caretHits}×)`);
  parts.push(`${s.edited ? '✓' : '·'} edited (${ev.humanEdits}×)`);
  parts.push(`${s.revisit ? '✓' : '·'} re-read (${ev.revisits ?? 0}× returned)`);
  const cost = lineText === undefined ? 1 : readCost(lineText, cfg);
  parts.push(
    `${s.readFraction >= 1 ? '✓' : '·'} read time ${(ev.focusedMs / 1000).toFixed(1)}s of ` +
      `${((cfg.readAckMs * cost) / 1000).toFixed(1)}s (${Math.round(s.readFraction * 100)}%)`,
  );
  const verdict = s.reviewed ? 'reviewed' : 'blindspot';
  return `${verdict} — ${s.points}/${cfg.reviewThresholdPoints} pts\n${parts.join('\n')}`;
}

/**
 * Merge two evidence records for the same logical line. Used when a file is
 * re-anchored after reload, and when merging evidence across editor groups
 * showing the same document.
 */
export function mergeEvidence(a: LineEvidence, b: LineEvidence): LineEvidence {
  return {
    visibleMs: a.visibleMs + b.visibleMs,
    focusedMs: a.focusedMs + b.focusedMs,
    dwellEvents: a.dwellEvents + b.dwellEvents,
    caretHits: a.caretHits + b.caretHits,
    humanEdits: a.humanEdits + b.humanEdits,
    revisits: (a.revisits ?? 0) + (b.revisits ?? 0),
    provenance: strongerProvenance(a.provenance, b.provenance),
    lastSeen: Math.max(a.lastSeen ?? 0, b.lastSeen ?? 0) || null,
  };
}

const PROVENANCE_RANK: Record<Provenance, number> = {
  'declared-ai': 3,
  bulk: 2,
  typed: 1,
  unknown: 0,
};

/** A declared-AI claim beats a bulk guess, which beats "the human typed it". */
export function strongerProvenance(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_RANK[a] >= PROVENANCE_RANK[b] ? a : b;
}

/** True when the line should be counted in the AI-generated bucket. */
export function isMachineAuthored(p: Provenance): boolean {
  return p === 'bulk' || p === 'declared-ai';
}
