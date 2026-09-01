import type { BlindspotConfig } from './config';
import { evaluate, isMachineAuthored } from './evidence';
import { classifyLine, maxRisk, riskRank, isSevere } from './risk';
import { computeScore, type ScoreBuckets } from './score';
import { emptyEvidence } from './types';
import type {
  BlindspotHunk,
  DiffReport,
  FileDiff,
  FileReport,
  LineEvidence,
  RiskLevel,
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

export function buildReport(
  diffs: FileDiff[],
  sources: ReportSources,
  cfg: BlindspotConfig,
  baseRef: string,
  now = Date.now(),
): DiffReport {
  const buckets: ScoreBuckets = {
    coverage: [0, 0],
    critical: [0, 0],
    newCode: [0, 0],
    ai: [0, 0],
  };

  const files: FileReport[] = [];
  const allHunks: BlindspotHunk[] = [];

  for (const diff of diffs) {
    if (diff.binary) continue;
    if (isIgnored(diff.file, cfg.ignore)) continue;
    if (diff.addedLines.length === 0) continue;

    const text = sources.getText(diff.file);
    const modified = new Set(diff.modifiedLines);

    let reviewedLines = 0;
    let weightedHit = 0;
    let weightedTotal = 0;
    let aiLines = 0;
    let aiReviewedLines = 0;
    const risks: RiskLevel[] = [];
    const unseen: Array<{ line: number; risk: RiskLevel; reason: string; ai: boolean }> = [];

    for (const line of diff.addedLines) {
      const lineText = text?.[line - 1] ?? '';
      const verdict = classifyLine(diff.file, lineText, cfg);
      const ev = sources.getEvidence(diff.file, line) ?? emptyEvidence();
      const signals = evaluate(ev, cfg, lineText);
      const weight = cfg.riskWeights[verdict.level] ?? 1;
      const ai = isMachineAuthored(ev.provenance);

      risks.push(verdict.level);
      weightedTotal += weight;
      buckets.coverage[1] += 1;
      if (isSevere(verdict.level)) buckets.critical[1] += 1;
      if (!modified.has(line)) buckets.newCode[1] += 1;
      if (ai) {
        aiLines += 1;
        buckets.ai[1] += 1;
      }

      if (signals.reviewed) {
        reviewedLines += 1;
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
      unseenLines: changedLines - reviewedLines,
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
    generatedAt: now,
    totalChangedLines,
    reviewedLines,
    unseenLines: totalChangedLines - reviewedLines,
    coverage,
    blindspot: 1 - coverage,
    score: computeScore(buckets, cfg),
    files,
    hunks: allHunks,
    worstFile: files.find((f) => f.unseenLines > 0) ?? null,
  };
}

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
