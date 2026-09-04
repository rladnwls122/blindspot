import type { BlindspotConfig, SignalWeights } from './config';
import { evaluate, isMachineAuthored } from './evidence';
import { classifyLine, maxRisk, riskRank, isSevere, type RiskVerdict } from './risk';
import { computeScore, type ScoreBuckets } from './score';
import { emptyActivity, emptyEvidence } from './types';
import type {
  ActivityCounts,
  BlindspotHunk,
  DiffReport,
  EvidenceSignals,
  FileDiff,
  FileReport,
  LineEvidence,
  ReadingMetrics,
  RiskLevel,
  TargetMode,
} from './types';

/**
 * Everything the report needs from the outside world. Injected so the report
 * builder stays pure and can be driven by the extension, the CLI, or a replay
 * of a recorded session.
 */
export interface ReportSources {
  /** Working-tree text of a file, split into lines. */
  getText(file: string): string[] | undefined;
  /** Evidence for a 1-based line, or undefined when nothing was observed. */
  getEvidence(file: string, line: number): LineEvidence | undefined;
}

/** Merge unreviewed lines into hunks, tolerating small reviewed gaps. */
const HUNK_GAP_TOLERANCE = 2;

/**
 * A whole file as a code target: every line, none of them "modified". This is
 * what general reading measures against, and it is the only thing that
 * differs between reading a codebase and reviewing a diff.
 */
export function wholeFileTarget(file: string, textLines: string[]): FileDiff {
  let count = textLines.length;
  // A trailing newline produces a final empty element that is not a line.
  if (count > 0 && textLines[count - 1] === '') count -= 1;
  return {
    file,
    addedLines: Array.from({ length: count }, (_, i) => i + 1),
    modifiedLines: [],
    deletedLines: 0,
    binary: false,
  };
}

export interface ReportOptions {
  mode?: TargetMode;
  activity?: ActivityCounts;
  /** The base is the commit a completed review ended at, not a plain ref. */
  sinceReview?: boolean;
}

/** The files a report is about: text, not ignored, with at least one target line. */
function targetFiles(diffs: FileDiff[], cfg: BlindspotConfig): FileDiff[] {
  return diffs.filter(
    (d) => !d.binary && !isIgnored(d.file, cfg.ignore) && d.addedLines.length > 0,
  );
}

interface EvaluatedLine {
  line: number;
  text: string;
  verdict: RiskVerdict;
  ev: LineEvidence;
  signals: EvidenceSignals;
}

/**
 * Every target line of one file, classified and judged. The report and the
 * interactive page both start from this, so they cannot disagree about which
 * lines exist or what was observed on them.
 */
function evaluateLines(diff: FileDiff, sources: ReportSources, cfg: BlindspotConfig): EvaluatedLine[] {
  const text = sources.getText(diff.file);
  return diff.addedLines.map((line) => {
    const lineText = text?.[line - 1] ?? '';
    const ev = sources.getEvidence(diff.file, line) ?? emptyEvidence();
    return {
      line,
      text: lineText,
      verdict: classifyLine(diff.file, lineText, cfg),
      ev,
      signals: evaluate(ev, cfg, lineText, diff.file),
    };
  });
}

export interface PageLine {
  n: number;
  text: string;
  risk: RiskLevel;
  reason: string;
  ai: boolean;
  /** Focused time against the acknowledgement time, in [0,1]; 1 is a read. */
  read: number;
  signals: Pick<EvidenceSignals, 'visible' | 'focused' | 'dwell' | 'caret' | 'edited' | 'revisit'>;
}

export interface PageData {
  weights: SignalWeights;
  threshold: number;
  riskWeights: Record<RiskLevel, number>;
  files: Array<{ path: string; lines: PageLine[] }>;
}

/**
 * The evidence behind a report, one row per target line, for the interactive
 * page. The page re-judges every line in the browser as its threshold moves,
 * from the same signals `buildReport` judged it by.
 */
export function pageData(diffs: FileDiff[], sources: ReportSources, cfg: BlindspotConfig): PageData {
  const files = targetFiles(diffs, cfg).map((diff) => ({
    path: diff.file,
    lines: evaluateLines(diff, sources, cfg).map(({ line, text, verdict, ev, signals }) => ({
      n: line,
      text,
      risk: verdict.level,
      reason: verdict.reason,
      ai: isMachineAuthored(ev.provenance),
      read: signals.readFraction,
      signals: {
        visible: signals.visible,
        focused: signals.focused,
        dwell: signals.dwell,
        caret: signals.caret,
        edited: signals.edited,
        revisit: signals.revisit,
      },
    })),
  }));
  return {
    weights: cfg.weights,
    threshold: cfg.reviewThresholdPoints,
    riskWeights: cfg.riskWeights,
    files,
  };
}

export function buildReport(
  diffs: FileDiff[],
  sources: ReportSources,
  cfg: BlindspotConfig,
  baseRef: string,
  now = Date.now(),
  opts: ReportOptions = {},
): DiffReport {
  const buckets: ScoreBuckets = {
    coverage: [0, 0],
    critical: [0, 0],
    newCode: [0, 0],
    ai: [0, 0],
  };

  const files: FileReport[] = [];
  const allHunks: BlindspotHunk[] = [];
  let readSum = 0;
  let focusSum = 0;
  let effectiveMs = 0;

  for (const diff of targetFiles(diffs, cfg)) {
    const modified = new Set(diff.modifiedLines);

    let reviewedLines = 0;
    let interactedLines = 0;
    let weightedHit = 0;
    let weightedTotal = 0;
    let aiLines = 0;
    let aiReviewedLines = 0;
    const risks: RiskLevel[] = [];
    const unseen: Array<{ line: number; risk: RiskLevel; reason: string; ai: boolean }> = [];

    for (const { line, verdict, ev, signals } of evaluateLines(diff, sources, cfg)) {
      const weight = cfg.riskWeights[verdict.level] ?? 1;
      const ai = isMachineAuthored(ev.provenance);

      risks.push(verdict.level);
      weightedTotal += weight;
      readSum += signals.readFraction;
      focusSum += signals.focusFraction;
      effectiveMs += Math.min(ev.focusedMs, cfg.focusCapMs);
      buckets.coverage[1] += 1;
      if (isSevere(verdict.level)) buckets.critical[1] += 1;
      if (!modified.has(line)) buckets.newCode[1] += 1;
      if (ai) {
        aiLines += 1;
        buckets.ai[1] += 1;
      }

      if (signals.reviewed) {
        reviewedLines += 1;
        if (signals.interacted) interactedLines += 1;
        weightedHit += weight;
        buckets.coverage[0] += 1;
        if (isSevere(verdict.level)) buckets.critical[0] += 1;
        if (!modified.has(line)) buckets.newCode[0] += 1;
        if (ai) {
          aiReviewedLines += 1;
          buckets.ai[0] += 1;
        }
      } else {
        unseen.push({ line, risk: verdict.level, reason: verdict.reason, ai });
      }
    }

    const changedLines = diff.addedLines.length;
    const hunks = groupHunks(diff.file, unseen);
    allHunks.push(...hunks);

    files.push({
      file: diff.file,
      changedLines,
      reviewedLines,
      interactedLines,
      unseenLines: changedLines - reviewedLines,
      deletedLines: diff.deletedLines,
      coverage: changedLines > 0 ? reviewedLines / changedLines : 1,
      weightedCoverage: weightedTotal > 0 ? weightedHit / weightedTotal : 1,
      risk: maxRisk(risks),
      blindspotRisk: maxRisk(unseen.map((u) => u.risk)),
      aiLines,
      aiReviewedLines,
      hunks,
    });
  }

  files.sort(bySeverity);
  allHunks.sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || b.lineCount - a.lineCount);

  const totalChangedLines = buckets.coverage[1];
  const reviewedLines = buckets.coverage[0];
  const coverage = totalChangedLines > 0 ? reviewedLines / totalChangedLines : 1;

  return {
    baseRef,
    sinceReview: opts.sinceReview ?? false,
    mode: opts.mode ?? 'diff',
    generatedAt: now,
    metrics: computeMetrics(
      { readSum, focusSum, effectiveMs, reviewedLines, targetLines: totalChangedLines },
      opts.activity ?? emptyActivity(),
      cfg,
    ),
    totalChangedLines,
    reviewedLines,
    interactedLines: files.reduce((n, f) => n + f.interactedLines, 0),
    unseenLines: totalChangedLines - reviewedLines,
    deletedLines: files.reduce((n, f) => n + f.deletedLines, 0),
    coverage,
    blindspot: 1 - coverage,
    score: computeScore(buckets, cfg),
    files,
    hunks: allHunks,
    worstFile: files.find((f) => f.unseenLines > 0) ?? null,
  };
}

/**
 * The three metrics, from per-line sums.
 *
 * Read and Focus are means over target lines, which is the same thing as
 * giving each of N lines a cap of 100/N points and adding up what it earned.
 * Activity is events per target line: one review action per twenty lines is
 * treated as fully active.
 * ponytail: linear saturation; replace with a fitted curve once there is data.
 */
export function computeMetrics(
  sums: {
    readSum: number;
    focusSum: number;
    effectiveMs: number;
    reviewedLines: number;
    targetLines: number;
  },
  counts: ActivityCounts,
  cfg: BlindspotConfig,
): ReadingMetrics {
  const n = sums.targetLines;
  const read = n > 0 ? sums.readSum / n : 1;
  const focus = n > 0 ? sums.focusSum / n : 0;
  const events =
    counts.jumps + counts.navigations + counts.edits + counts.marks * 5 + counts.completions * 10;
  const activity = n > 0 ? Math.min(1, events / Math.max(1, n * 0.05)) : 0;
  const w = cfg.finalWeights;
  const wsum = w.read + w.focus + w.activity;
  const final = wsum > 0 ? (w.read * read + w.focus * focus + w.activity * activity) / wsum : 0;
  const score = (f: number) => Math.round(f * 1000) / 10;
  // Focused time is handed out from a budget of `attentionLines` line-seconds
  // per second, so summing it back up and dividing by the throughput recovers
  // the seconds of attention the target lines received. It is a floor: time
  // on context lines outside the target is not in the sum, so the pace it
  // implies is, if anything, an overestimate — the direction that says
  // "distrust this" rather than "well done".
  const attentionMs = Math.round(sums.effectiveMs / Math.max(1, cfg.attentionLines));
  const linesPerMinute =
    attentionMs > 0 ? Math.round((sums.reviewedLines / (attentionMs / 60_000)) * 10) / 10 : null;
  return {
    read: { fraction: read, score: score(read), reviewedLines: sums.reviewedLines, targetLines: n },
    focus: { fraction: focus, score: score(focus), effectiveMs: Math.round(sums.effectiveMs) },
    activity: { fraction: activity, score: score(activity), counts },
    pace: { attentionMs, linesPerMinute },
    final: score(final),
  };
}

/**
 * Lines an hour above which review studies see defect detection fall off
 * (the SmartBear / Cisco figure of 300–500 LOC/h; this is the upper end).
 */
export const PACE_CEILING_LINES_PER_MINUTE = 500 / 60;

/**
 * Ranking, worst blindspot first.
 *
 * Risk dominates volume, and it is deliberately lexicographic rather than a
 * product. The product form (`unseen × risk`) lets a big enough pile of
 * low-stakes lines outrank genuinely dangerous ones — 40 unread README lines
 * beating 3 unread lines in `auth/session.ts` — which is exactly the judgement
 * this tool exists to get right. Volume only breaks ties inside a risk level.
 */
function bySeverity(a: FileReport, b: FileReport): number {
  const aBlind = a.unseenLines > 0;
  const bBlind = b.unseenLines > 0;
  if (aBlind !== bBlind) return aBlind ? -1 : 1;
  if (!aBlind) return riskRank(b.risk) - riskRank(a.risk);
  return (
    riskRank(b.blindspotRisk) - riskRank(a.blindspotRisk) ||
    b.unseenLines - a.unseenLines ||
    a.file.localeCompare(b.file)
  );
}

function groupHunks(
  file: string,
  unseen: Array<{ line: number; risk: RiskLevel; reason: string; ai: boolean }>,
): BlindspotHunk[] {
  if (unseen.length === 0) return [];
  const sorted = [...unseen].sort((a, b) => a.line - b.line);
  const hunks: BlindspotHunk[] = [];
  let batch = [sorted[0]];

  const flush = () => {
    const lines = batch.map((b) => b.line);
    const level = maxRisk(batch.map((b) => b.risk));
    const reason = batch.find((b) => b.risk === level)?.reason ?? '';
    hunks.push({
      file,
      startLine: lines[0],
      endLine: lines[lines.length - 1],
      lineCount: lines.length,
      risk: level,
      reason,
      aiRatio: batch.filter((b) => b.ai).length / batch.length,
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = batch[batch.length - 1];
    if (sorted[i].line - prev.line <= HUNK_GAP_TOLERANCE + 1) {
      batch.push(sorted[i]);
    } else {
      flush();
      batch = [sorted[i]];
    }
  }
  flush();
  return hunks;
}

/** Minimal glob support: `**`, `*`, and literal segments. */
export function isIgnored(file: string, patterns: string[]): boolean {
  const normalized = file.replace(/\\/g, '/');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` should also match zero directories.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}
