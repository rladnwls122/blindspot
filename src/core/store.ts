import type { StoredLine } from './ledger';
import { emptyActivity, emptyEvidence, type ActivityCounts, type LineEvidence, type Provenance } from './types';

// 2: focused time became a conserved budget (see attention.ts). Evidence
// recorded under version 1 handed every visible line the whole tick, so its
// numbers are inflated and cannot be trusted; it is discarded, not converted.
export const STATE_VERSION = 2;

export interface BlindspotState {
  version: number;
  updatedAt: number;
  /** Repo-relative path -> content-anchored evidence. */
  files: Record<string, StoredLine[]>;
  /** Cumulative wall-clock ms spent with Blindspot tracking in this repo. */
  trackedMs: number;
  /** Review actions, counted. Stored beside the evidence, never folded into it. */
  activity: ActivityCounts;
  /**
   * The commit the last completed review ended at. Everything committed after
   * it is unreviewed until the next completion. Null until a review completes.
   */
  baseline: { commit: string; setAt: number } | null;
  /**
   * Paths the reader has said not to measure — a vendored tree opened once by
   * accident, a generated file. Files or folders, workspace-relative.
   *
   * It lives in the state and not in `.blindspot/config.json` on purpose. That
   * file is committed and decides what is risky for the whole team; this is one
   * person saying what they are not reading, which is the same kind of fact as
   * the evidence it sits beside, and belongs in the same private place.
   *
   * Deleting the evidence is not enough on its own: a file still open in a tab
   * gets a fresh ledger on the next tick and walks straight back into the
   * denominator. This is what keeps it out.
   */
  ignored: string[];
}

export function emptyState(): BlindspotState {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    files: {},
    trackedMs: 0,
    activity: emptyActivity(),
    baseline: null,
    ignored: [],
  };
}

/**
 * Parse persisted state defensively. The state file lives in `.git/blindspot`
 * and is never committed, so it can be stale, truncated by a crash, or written
 * by an older version. Anything we cannot read becomes "no evidence", which
 * degrades to asking you to review the code again — the safe direction.
 */
export function parseState(raw: string): BlindspotState {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!data || typeof data !== 'object') return emptyState();
  const obj = data as Record<string, unknown>;
  if (obj.version !== STATE_VERSION) return emptyState();

  const files: Record<string, StoredLine[]> = {};
  const rawFiles = obj.files;
  if (rawFiles && typeof rawFiles === 'object') {
    for (const [file, lines] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (!Array.isArray(lines)) continue;
      const parsed: StoredLine[] = [];
      for (const entry of lines) {
        const line = parseStoredLine(entry);
        if (line) parsed.push(line);
      }
      if (parsed.length > 0) files[file] = parsed;
    }
  }

  return {
    version: STATE_VERSION,
    updatedAt: num(obj.updatedAt, Date.now()),
    files,
    trackedMs: num(obj.trackedMs, 0),
    activity: parseActivity(obj.activity),
    baseline: parseBaseline(obj.baseline),
    ignored: parseIgnored(obj.ignored),
  };
}

/** Added after version 2 shipped; an older state simply ignores nothing. */
function parseIgnored(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return [...new Set(out)].sort();
}

/** True when `file` is a forgotten path, or lives under a forgotten folder. */
export function isForgotten(ignored: readonly string[], file: string): boolean {
  return ignored.some((p) => file === p || file.startsWith(`${p}/`));
}

function parseActivity(v: unknown): ActivityCounts {
  const out = emptyActivity();
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof ActivityCounts>) out[k] = num(o[k], 0);
  return out;
}

function parseBaseline(v: unknown): BlindspotState['baseline'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  // A commit hash is hex; anything else is not something to hand to git.
  if (typeof o.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o.commit)) return null;
  return { commit: o.commit, setAt: num(o.setAt, 0) };
}

function parseStoredLine(entry: unknown): StoredLine | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  if (typeof o.h !== 'string') return null;
  const e = o.e;
  if (!e || typeof e !== 'object') return null;
  const ev = e as Record<string, unknown>;
  const evidence: LineEvidence = {
    ...emptyEvidence(),
    visibleMs: num(ev.visibleMs, 0),
    focusedMs: num(ev.focusedMs, 0),
    dwellEvents: num(ev.dwellEvents, 0),
    caretHits: num(ev.caretHits, 0),
    // Added after version 2 shipped; a record without it simply never saw
    // the mouse, which is what zero means.
    pointerHits: num(ev.pointerHits, 0),
    humanEdits: num(ev.humanEdits, 0),
    revisits: num(ev.revisits, 0),
    provenance: provenance(ev.provenance),
    lastSeen: typeof ev.lastSeen === 'number' ? ev.lastSeen : null,
  };
  return { h: o.h, i: num(o.i, 0), e: evidence };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function provenance(v: unknown): Provenance {
  return v === 'typed' || v === 'bulk' || v === 'declared-ai' ? v : 'unknown';
}

export function serializeState(state: BlindspotState): string {
  return JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: Date.now() });
}

/**
 * Drop files we have not touched in a while, so the state file stays small in
 * long-lived repos. Evidence for a file nobody has opened in weeks is not
 * useful — the diff has moved on.
 */
export function pruneState(state: BlindspotState, maxAgeMs: number, now = Date.now()): BlindspotState {
  const files: Record<string, StoredLine[]> = {};
  for (const [file, lines] of Object.entries(state.files)) {
    const freshest = lines.reduce((max, l) => Math.max(max, l.e.lastSeen ?? 0), 0);
    if (freshest === 0 || now - freshest <= maxAgeMs) files[file] = lines;
  }
  return { ...state, files };
}

/**
 * Drop everything recorded for one file, or for a folder and everything under
 * it, and say how many files went.
 *
 * Reading mode's target is every file with evidence, so a 3,000-line vendored
 * file opened once by accident becomes 3,000 lines of the denominator and
 * stays there. Nothing else in the model can take it back out: the evidence is
 * real, the file is real, and prune only forgets what has gone untouched for a
 * month. This is the deliberate way out, and it is deliberate in both
 * directions — the evidence is gone, not hidden.
 */
export function forgetFiles(
  state: BlindspotState,
  target: string,
): { state: BlindspotState; forgotten: string[] } {
  const prefix = target.replace(/\/+$/, '');
  const forgotten: string[] = [];
  const files: Record<string, StoredLine[]> = {};
  for (const [file, lines] of Object.entries(state.files)) {
    if (file === prefix || file.startsWith(`${prefix}/`)) forgotten.push(file);
    else files[file] = lines;
  }
  // Remember the decision, not just its effect: an open file would earn fresh
  // evidence on the next tick and be back in the denominator by the time
  // anyone looked. Folders already covered by a broader entry are dropped.
  const ignored = [...state.ignored.filter((p) => p !== prefix && !p.startsWith(`${prefix}/`)), prefix];
  return { state: { ...state, files, ignored: [...new Set(ignored)].sort() }, forgotten: forgotten.sort() };
}

/** Undo a `forgetFiles`: measure this path again. The evidence stays gone. */
export function measureAgain(state: BlindspotState, target: string): { state: BlindspotState; restored: string[] } {
  const prefix = target.replace(/\/+$/, '');
  const restored = state.ignored.filter((p) => p === prefix || p.startsWith(`${prefix}/`));
  if (restored.length === 0) return { state, restored: [] };
  return {
    state: { ...state, ignored: state.ignored.filter((p) => !restored.includes(p)) },
    restored: restored.sort(),
  };
}

/**
 * Declared-AI regions, written by an agent or CI into
 * `.blindspot/ai-regions.json`:
 *
 *     { "src/api.ts": [[10, 42], [80, 96]] }
 */
export type AiRegions = Record<string, Array<[number, number]>>;

export function parseAiRegions(raw: string): AiRegions {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    const out: AiRegions = {};
    for (const [file, ranges] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(ranges)) continue;
      const parsed = ranges
        .filter((r): r is [number, number] =>
          Array.isArray(r) && r.length >= 2 && typeof r[0] === 'number' && typeof r[1] === 'number')
        .map((r) => [Math.max(1, r[0]), Math.max(1, r[1])] as [number, number]);
      if (parsed.length > 0) out[file] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}
