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
  /**
   * Times the mouse pointer came to rest on this line. The editor reports it
   * through the hover request it makes when the pointer stops over a token —
   * the one place an IDE lets slip where the mouse is, and mouse position is
   * the closest thing to gaze an editor can observe.
   */
  pointerHits: number;
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
    pointerHits: 0,
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
  /**
   * The reader did something to this line — placed the caret, rested the
   * mouse on it, or typed in it — rather than only having it on screen. A
   * verdict backed by interaction is one nobody has to take on trust.
   */
  interacted: boolean;
  reviewed: boolean;
}

/**
 * What the report measures against. Two modes, and the user switches between
 * them from the panel, the status bar or the command palette.
 *
 * - `diff`     the lines you changed: the working tree against a base. The
 *              base is the last completed review when there is one, or
 *              `baseRef` (HEAD by default). Needs git.
 * - `reading`  every line of every file you have opened here. Needs no git.
 */
export type TargetMode = 'diff' | 'reading';

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
  /**
   * How fast the reviewed lines were read. Attention is a conserved budget
   * (see `attention.ts`), so the focused time credited to the target lines
   * divided by the throughput of that budget is roughly the wall-clock
   * attention they received. `linesPerMinute` is null until any time at all
   * has been spent. Review studies put the ceiling for still catching defects
   * at 300–500 lines an hour; a pace far above that is a number to distrust.
   */
  pace: { attentionMs: number; linesPerMinute: number | null };
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
  /** Reviewed lines the reader also interacted with (caret, mouse or edit). */
  interactedLines: number;
  unseenLines: number;
  /**
   * Lines removed with no replacement. They are reported, never scored: you
   * cannot fail to read a line that is no longer there, but a deletion can
   * absolutely be the bug, so the report says how many there were.
   */
  deletedLines: number;
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
  /** True when `baseRef` is the commit a completed review ended at. */
  sinceReview: boolean;
  mode: TargetMode;
  generatedAt: number;
  metrics: ReadingMetrics;
  totalChangedLines: number;
  reviewedLines: number;
  /** Reviewed lines backed by interaction, not screen time alone. */
  interactedLines: number;
  unseenLines: number;
  /** Lines deleted across the diff; reported, not scored. */
  deletedLines: number;
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
