import type { RiskLevel } from './types';

/**
 * Weights for the five evidence signals. The defaults encode the working
 * definition of "read" this project starts from:
 *
 *     visible                    = 1     (it was on screen)
 *     focused                    = 1     (it was on screen in the editor you were in)
 *     dwell (viewport held still)= 1     (you stopped moving)
 *     caret / selection          = 1     (you navigated to it)
 *     human edit                 = 2     (you wrote it)
 *
 * with `reviewThresholdPoints = 3`, which makes the three inequalities in the
 * design brief literally true:
 *
 *     scroll over line          -> 1 point  -> not reviewed
 *     visible for 0.2s          -> 0 points -> not reviewed
 *     visible + pause + caret   -> 3 points -> reviewed
 */
export interface SignalWeights {
  visible: number;
  focused: number;
  dwell: number;
  caret: number;
  edited: number;
}

export interface RiskRule {
  /** Regex source, matched case-insensitively. */
  pattern: string;
  level: RiskLevel;
  reason: string;
  /**
   * Content rules only: the line carries no executable behaviour (a comment,
   * a blank line). Inert lines are demoted one rank below their file's risk
   * rather than inheriting it, so that reading the comment above a secret is
   * not scored the same as reading the secret.
   */
  inert?: boolean;
}

export interface BlindspotConfig {
  reviewThresholdPoints: number;
  weights: SignalWeights;
  /** Ms on screen before the visibility point is earned. */
  visibleMsForPoint: number;
  /** Ms on screen in the focused, active editor before the focus point is earned. */
  focusedMsForPoint: number;
  /** Ms the viewport must hold still to count as a dwell. */
  dwellMs: number;
  /** Discard visibility credit while scrolling faster than a human reads. */
  readingSpeedGuard: boolean;
  maxLinesPerSecond: number;
  /** Multipliers used when computing weighted coverage. */
  riskWeights: Record<RiskLevel, number>;
  /** Path rules, first match wins. */
  pathRules: RiskRule[];
  /** Content rules applied to the text of a changed line, first match wins. */
  contentRules: RiskRule[];
  /** Composite score weights. Renormalised over the components that exist. */
  scoreWeights: { coverage: number; critical: number; newCode: number; ai: number };
  /** A single insertion of at least this many lines is treated as machine-inserted. */
  bulkInsertLines: number;
  /** ...or at least this many characters in one content-change event. */
  bulkInsertChars: number;
  /** Paths never tracked or reported. */
  ignore: string[];
  /** Coverage percentage below which the CLI hook fails. */
  minCoverage: number;
  /** Unreviewed critical lines above which the CLI hook fails. */
  maxCriticalBlindspotLines: number;
}

export const DEFAULT_CONFIG: BlindspotConfig = {
  reviewThresholdPoints: 3,
  weights: { visible: 1, focused: 1, dwell: 1, caret: 1, edited: 2 },
  visibleMsForPoint: 300,
  focusedMsForPoint: 800,
  dwellMs: 1000,
  readingSpeedGuard: true,
  maxLinesPerSecond: 45,
  riskWeights: { critical: 4, high: 3, medium: 2, low: 1 },
  pathRules: [
    { pattern: '(^|/)(auth|authentication|authorization|session|login|signin|oauth|saml|sso)', level: 'critical', reason: 'authentication / session code' },
    { pattern: '(secret|credential|password|token|apikey|api_key|private_?key|keystore)', level: 'critical', reason: 'credential handling' },
    { pattern: '(crypto|cipher|encrypt|decrypt|hashing|signature|jwt)', level: 'critical', reason: 'cryptography' },
    { pattern: '(payment|billing|invoice|charge|checkout|refund|payout|ledger)', level: 'critical', reason: 'money movement' },
    { pattern: '(migration|migrations|schema\\.|\\.sql$|prisma/|alembic)', level: 'critical', reason: 'data migration / schema' },
    { pattern: '(permission|policy|acl|rbac|role|guard|middleware)', level: 'high', reason: 'access control' },
    { pattern: '(^|/)(infra|terraform|k8s|kubernetes|helm|deploy|Dockerfile|\\.github/workflows/)', level: 'high', reason: 'deployment / infrastructure' },
    { pattern: '(config|settings|env|\\.env)', level: 'high', reason: 'configuration' },
    { pattern: '\\.(lock|snap)$|(^|/)(dist|build|vendor|node_modules)/', level: 'low', reason: 'generated / vendored' },
    { pattern: '(^|/)(test|tests|__tests__|spec)/|\\.(test|spec)\\.[a-z]+$', level: 'low', reason: 'test code' },
    { pattern: '\\.(md|mdx|txt|rst|json5?|ya?ml|toml)$', level: 'low', reason: 'docs / data' },
  ],
  contentRules: [
    { pattern: '\\b(eval|exec|execSync|spawnSync|child_process|Function\\s*\\()', level: 'critical', reason: 'dynamic code execution' },
    { pattern: '\\b(rm\\s+-rf|DROP\\s+TABLE|TRUNCATE|DELETE\\s+FROM)\\b', level: 'critical', reason: 'destructive operation' },
    { pattern: 'dangerouslySetInnerHTML|innerHTML\\s*=', level: 'high', reason: 'raw HTML injection' },
    { pattern: '\\b(verify|sign|compare|hash)\\s*\\(|bcrypt|scrypt|pbkdf2|createHmac', level: 'high', reason: 'credential verification' },
    { pattern: 'process\\.env\\.|os\\.environ|System\\.getenv', level: 'high', reason: 'environment / secrets access' },
    { pattern: '(SELECT|INSERT|UPDATE)\\b.*(\\+|\\$\\{|%s|f")', level: 'high', reason: 'string-built SQL' },
    { pattern: '\\b(fetch|axios|request|http\\.(get|post)|urlopen)\\b', level: 'medium', reason: 'network call' },
    { pattern: '\\b(catch|except)\\b\\s*[\\({]?\\s*[\\)\\{:]', level: 'medium', reason: 'error handling' },
    { pattern: '^\\s*(//|#|\\*|/\\*)', level: 'low', reason: 'comment', inert: true },
  ],
  scoreWeights: { coverage: 0.4, critical: 0.3, newCode: 0.15, ai: 0.15 },
  bulkInsertLines: 8,
  bulkInsertChars: 280,
  ignore: [
    '**/node_modules/**',
    '**/out/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/*.lock',
    '**/package-lock.json',
  ],
  minCoverage: 70,
  maxCriticalBlindspotLines: 0,
};

/** Shallow-merge a partial config (from `.blindspot/config.json` or settings). */
export function mergeConfig(
  base: BlindspotConfig,
  patch: Partial<BlindspotConfig> | undefined | null,
): BlindspotConfig {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    weights: { ...base.weights, ...(patch.weights ?? {}) },
    riskWeights: { ...base.riskWeights, ...(patch.riskWeights ?? {}) },
    scoreWeights: { ...base.scoreWeights, ...(patch.scoreWeights ?? {}) },
    pathRules: patch.pathRules ?? base.pathRules,
    contentRules: patch.contentRules ?? base.contentRules,
    ignore: patch.ignore ?? base.ignore,
  };
}

export function maxPoints(w: SignalWeights): number {
  return w.visible + w.focused + w.dwell + w.caret + w.edited;
}
