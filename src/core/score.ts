import type { BlindspotConfig } from './config';
import type { ScoreBreakdown } from './types';

export interface ScoreBuckets {
  /** [reviewed, total] over every changed line. */
  coverage: [number, number];
  /** [reviewed, total] over critical + high risk changed lines. */
  critical: [number, number];
  /** [reviewed, total] over lines that are new rather than modified. */
  newCode: [number, number];
  /** [reviewed, total] over machine-inserted / declared-AI lines. */
  ai: [number, number];
}

function ratio([hit, total]: [number, number]): number {
  return total > 0 ? hit / total : 0;
}

/**
 * Compose the 0-100 Review Score.
 *
 * Components with no lines to measure are dropped and their weight is spread
 * over the rest, so a diff that touches no critical code is not punished for
 * having nothing critical to review — and, importantly, a diff that is *all*
 * critical code is scored entirely on how well you read critical code.
 */
export function computeScore(buckets: ScoreBuckets, cfg: BlindspotConfig): ScoreBreakdown {
  const measured = {
    coverage: buckets.coverage[1] > 0,
    critical: buckets.critical[1] > 0,
    newCode: buckets.newCode[1] > 0,
    ai: buckets.ai[1] > 0,
  };

  const parts: Array<[keyof ScoreBuckets, number, boolean]> = [
    ['coverage', cfg.scoreWeights.coverage, measured.coverage],
    ['critical', cfg.scoreWeights.critical, measured.critical],
    ['newCode', cfg.scoreWeights.newCode, measured.newCode],
    ['ai', cfg.scoreWeights.ai, measured.ai],
  ];

  const activeWeight = parts.reduce((sum, [, w, on]) => sum + (on ? w : 0), 0);
  let score = 0;
  if (activeWeight > 0) {
    for (const [key, w, on] of parts) {
      if (!on) continue;
      score += (w / activeWeight) * ratio(buckets[key]);
    }
  }

  return {
    coverage: ratio(buckets.coverage),
    critical: ratio(buckets.critical),
    newCode: ratio(buckets.newCode),
    ai: ratio(buckets.ai),
    score: Math.round(score * 100),
    measured,
  };
}

/** `████████░░` style bar, for the panel and the terminal. */
export function bar(fraction: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function pct(fraction: number): number {
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}
