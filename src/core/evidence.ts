import { maxPoints, type BlindspotConfig } from './config';
import type { EvidenceSignals, LineEvidence, Provenance } from './types';

/**
 * Turn raw observations into the five booleans, then into points.
 *
 * The whole research question of this project lives in this function. It is
 * deliberately small, deliberately explainable, and deliberately separate from
 * the code that collects the evidence — so that the definition of "read" can be
 * changed and replayed without recollecting anything.
 */
export function evaluate(ev: LineEvidence, cfg: BlindspotConfig): EvidenceSignals {
  const visible = ev.visibleMs >= cfg.visibleMsForPoint;
  const focused = ev.focusedMs >= cfg.focusedMsForPoint;
  const dwell = ev.dwellEvents > 0;
  const caret = ev.caretHits > 0;
  const edited = ev.humanEdits > 0;

  const w = cfg.weights;
  const points =
    (visible ? w.visible : 0) +
    (focused ? w.focused : 0) +
    (dwell ? w.dwell : 0) +
    (caret ? w.caret : 0) +
    (edited ? w.edited : 0);

  const max = maxPoints(w);
  return {
    visible,
    focused,
    dwell,
    caret,
    edited,
    points,
    confidence: max > 0 ? Math.min(1, points / max) : 0,
    reviewed: points >= cfg.reviewThresholdPoints,
  };
}

/** Human-readable explanation of a verdict, for tooltips and the CLI. */
export function explain(ev: LineEvidence, cfg: BlindspotConfig): string {
  const s = evaluate(ev, cfg);
  const parts: string[] = [];
  parts.push(`${s.visible ? '✓' : '·'} on screen (${Math.round(ev.visibleMs)}ms)`);
  parts.push(`${s.focused ? '✓' : '·'} focused (${Math.round(ev.focusedMs)}ms)`);
  parts.push(`${s.dwell ? '✓' : '·'} paused (${ev.dwellEvents}×)`);
  parts.push(`${s.caret ? '✓' : '·'} navigated (${ev.caretHits}×)`);
  parts.push(`${s.edited ? '✓' : '·'} edited (${ev.humanEdits}×)`);
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
