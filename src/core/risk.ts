import type { BlindspotConfig, RiskRule } from './config';
import type { RiskLevel } from './types';

const RANK: Record<RiskLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
  /** Set when the verdict came from a rule marked inert (comments, blanks). */
  inert?: boolean;
}

const DEFAULT_VERDICT: RiskVerdict = { level: 'medium', reason: 'application code' };

interface CompiledRule {
  re: RegExp;
  level: RiskLevel;
  reason: string;
  inert: boolean;
}

const cache = new WeakMap<RiskRule[], CompiledRule[]>();

function compile(rules: RiskRule[]): CompiledRule[] {
  let compiled = cache.get(rules);
  if (!compiled) {
    compiled = rules.map((r) => ({
      re: new RegExp(r.pattern, 'i'),
      level: r.level,
      reason: r.reason,
      inert: r.inert === true,
    }));
    cache.set(rules, compiled);
  }
  return compiled;
}

/** Risk implied by where the file lives. First matching rule wins. */
export function classifyPath(file: string, cfg: BlindspotConfig): RiskVerdict {
  const normalized = file.replace(/\\/g, '/');
  for (const rule of compile(cfg.pathRules)) {
    if (rule.re.test(normalized)) return { level: rule.level, reason: rule.reason };
  }
  return DEFAULT_VERDICT;
}

/** Risk implied by what a line says. Returns null when nothing matches. */
export function classifyContent(text: string, cfg: BlindspotConfig): RiskVerdict | null {
  if (!text.trim()) return { level: 'low', reason: 'blank line', inert: true };
  for (const rule of compile(cfg.contentRules)) {
    if (rule.re.test(text)) {
      return rule.inert
        ? { level: rule.level, reason: rule.reason, inert: true }
        : { level: rule.level, reason: rule.reason };
    }
  }
  return null;
}

/**
 * Combined risk for one line.
 *
 * Three cases, in order:
 *  - a `low` path (docs, tests, lockfiles) caps the line's risk, because a
 *    scary-looking regex inside a markdown fence is still markdown;
 *  - an inert line (comment, blank) is demoted one rank below its file, since
 *    you cannot ship an auth bug in a comment — and without this, every
 *    comment in `auth/` would weigh as much as the code it describes;
 *  - otherwise the higher of the two signals wins, because a `child_process`
 *    call in an ordinary util file is worse than either signal alone suggests.
 */
export function classifyLine(file: string, text: string, cfg: BlindspotConfig): RiskVerdict {
  const path = classifyPath(file, cfg);
  const content = classifyContent(text, cfg);
  if (!content) return path;
  if (path.level === 'low') return path;
  if (content.inert) {
    return { level: demote(path.level), reason: `${content.reason} in ${path.reason}` };
  }
  return higher(path, content);
}

const DEMOTED: Record<RiskLevel, RiskLevel> = {
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
};

export function demote(level: RiskLevel): RiskLevel {
  return DEMOTED[level];
}

export function higher(a: RiskVerdict, b: RiskVerdict): RiskVerdict {
  return RANK[a.level] >= RANK[b.level] ? a : b;
}

export function riskRank(level: RiskLevel): number {
  return RANK[level];
}

export function isSevere(level: RiskLevel): boolean {
  return level === 'critical' || level === 'high';
}

export function maxRisk(levels: RiskLevel[]): RiskLevel {
  let best: RiskLevel = 'low';
  for (const l of levels) if (RANK[l] > RANK[best]) best = l;
  return best;
}
