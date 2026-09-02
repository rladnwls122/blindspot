/**
 * Core domain types. Nothing in `src/core` may import `vscode` — the whole
 * point of this boundary is that the scoring model can be unit-tested, run in
 * the CLI, and replayed against recorded sessions without an editor.
 */

/**
 * Where a line came from. We cannot honestly claim to know that a line was
 * written by an LLM, so we record the observable fact instead:
 *
 * - `typed`       the line was built up by human keystrokes
 * - `bulk`        the line arrived in one large machine-speed insertion
 *                 (an agent write, a paste, a refactor tool, a formatter)
 * - `declared-ai` some tool explicitly claimed authorship via
 *                 `.blindspot/ai-regions.json` or a commit trailer
 * - `unknown`     the line predates tracking, or came from disk
 */
export type Provenance = 'typed' | 'bulk' | 'declared-ai' | 'unknown';

/** How dangerous a line is if you get it wrong. */
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Everything we observed about one line. Deliberately raw: we store the
 * evidence, not the verdict, so the scoring model can be retuned later and
 * replayed over history without losing information.
 */
export interface LineEvidence {
  /** Total ms the line spent inside a visible range of any editor. */
  visibleMs: number;
  /** Ms visible in the *active* editor while the window itself had focus. */
  focusedMs: number;
  /** Times the viewport held still (>= dwellMs) while this line was on screen. */
  dwellEvents: number;
  /** Times the caret was placed on, or a selection covered, this line. */
  caretHits: number;
  /** Times a human keystroke changed this line. */
  humanEdits: number;
  /**
   * Times the line came back on screen after being away long enough to count
   * as a separate viewing episode. Re-reading is one of the few comprehension
   * signals an IDE can observe without an eye tracker.
   */
  revisits: number;
  /** Best-effort authorship signal. */
  provenance: Provenance;
  /** Epoch ms of the last observation, or null if never observed. */
  lastSeen: number | null;
}

export function emptyEvidence(provenance: Provenance = 'unknown'): LineEvidence {
  return {
    visibleMs: 0,
    focusedMs: 0,
    dwellEvents: 0,
    caretHits: 0,
    humanEdits: 0,
    revisits: 0,
    provenance,
    lastSeen: null,
  };
}

/** The six signals the scoring model reads, plus the points they earned. */
export interface EvidenceSignals {
  visible: boolean;
  focused: boolean;
  dwell: boolean;
  caret: boolean;
  edited: boolean;
  revisit: boolean;
  points: number;
  /** points / maxPoints, in [0,1]. */
  confidence: number;
  /** Focused time against the read acknowledgement time, in [0,1]. */
  readFraction: number;
  /** Focused time against the focus ceiling, in [0,1]. */
  focusFraction: number;
  reviewed: boolean;
}

/**
 * What the report measures against.
 *
 * - `diff`       working tree against `baseRef` (a PR-style review)
 * - `unreviewed` everything since the last completed review, commits included
 * - `reading`    every line of every file you have opened here; no git needed
 */
export type TargetMode = 'diff' | 'unreviewed' | 'reading';

/** Review actions, counted per workspace. Raw counts, never merged into time. */
export interface ActivityCounts {
  /** Jumps to a blindspot, from the navigator or the report. */
  jumps: number;
  /** Caret / selection moves inside tracked files. */
  navigations: number;
  /** Human edit batches. */
  edits: number;
  /** "Mark as reviewed" overrides. */
  marks: number;
  /** Reviews completed (baseline advanced). */
  completions: number;
}

export function emptyActivity(): ActivityCounts {
  return { jumps: 0, navigations: 0, edits: 0, marks: 0, completions: 0 };
}

/**
 * The three measurements, kept apart. Each is in [0,1]; `*Score` is the same
 * thing on 0–100. `final` is the optional weighted composite and is derived —
 * nothing here is ever stored merged.
 */
export interface ReadingMetrics {
  /** Mean per-line read fraction: each of N lines is worth 100/N points. */
  read: { fraction: number; score: number; reviewedLines: number; targetLines: number };
  /** Mean per-line focus fraction, and the effective (capped) focused ms. */
  focus: { fraction: number; score: number; effectiveMs: number };
  /** Activity events per target line, saturating. */
  activity: { fraction: number; score: number; counts: ActivityCounts };
  final: number;
}

/** One changed line, joined with what we know about it. */
export interface LineVerdict {
  /** 1-based line number in the working-tree version of the file. */
  line: number;
  signals: EvidenceSignals;
  risk: RiskLevel;
  provenance: Provenance;
  /** True when the line is an addition/modification (not context). */
  changed: boolean;
}

/** A contiguous run of unreviewed changed lines — what the UI navigates to. */
export interface BlindspotHunk {
  file: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  risk: RiskLevel;
  /** Highest-risk reason we could attribute, for the UI. */
  reason: string;
  /** Fraction of the hunk that is machine-inserted or declared AI. */
  aiRatio: number;
}

export interface FileReport {
  file: string;
  changedLines: number;
  reviewedLines: number;
  unseenLines: number;
  coverage: number;
  /** Coverage counting each line by its risk weight. */
  weightedCoverage: number;
  /** Highest risk among the file's changed lines. */
  risk: RiskLevel;
  /**
   * Highest risk among the lines still *unread*. This is what ranks the file:
   * a file whose only unread lines are comments is not a critical blindspot,
   * however dangerous the rest of its diff was.
   */
  blindspotRisk: RiskLevel;
  aiLines: number;
  aiReviewedLines: number;
  hunks: BlindspotHunk[];
}

export interface ScoreBreakdown {
  /** Plain line coverage over the whole diff. */
  coverage: number;
  /** Coverage restricted to critical/high risk lines. */
  critical: number;
  /** Coverage over lines that are new (added, not modified context). */
  newCode: number;
  /** Coverage over machine-inserted / declared-AI lines. */
  ai: number;
  /** 0-100 composite. */
  score: number;
  /** Which components actually had lines to measure. */
  measured: { coverage: boolean; critical: boolean; newCode: boolean; ai: boolean };
}

export interface DiffReport {
  baseRef: string;
  mode: TargetMode;
  generatedAt: number;
  metrics: ReadingMetrics;
  totalChangedLines: number;
  reviewedLines: number;
  unseenLines: number;
  coverage: number;
  blindspot: number;
  score: ScoreBreakdown;
  files: FileReport[];
  /** All blindspot hunks across files, worst risk first. */
  hunks: BlindspotHunk[];
  /** Highest-risk file that still has unreviewed lines, if any. */
  worstFile: FileReport | null;
}

/** A changed-line set for one file, as parsed out of a unified diff. */
export interface FileDiff {
  file: string;
  /** 1-based line numbers in the new file that were added or modified. */
  addedLines: number[];
  /** Lines that existed before and were modified (subset of addedLines). */
  modifiedLines: number[];
  /** Number of lines deleted with no replacement; tracked for reporting only. */
  deletedLines: number;
  binary: boolean;
}
