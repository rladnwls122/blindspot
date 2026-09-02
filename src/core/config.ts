import type { RiskLevel } from './types';

/**
 * Weights for the six evidence signals. The defaults encode the working
 * definition of "read" this project starts from:
 *
 *     visible                    = 1     (it was on screen)
 *     focused                    = 1     (it was on screen in the editor you were in)
 *     dwell (viewport held still)= 1     (you stopped moving)
 *     caret / selection          = 1     (you navigated to it)
 *     human edit                 = 2     (you wrote it)
 *     revisit (came back later)  = 1     (you read it more than once)
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
  /** Came back to the line in a later viewing episode (re-reading). */
  revisit: number;
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
  /**
   * Weight a tick's visibility credit by distance from the reader's focus
   * instead of spreading it flat across the viewport. See `core/attention.ts`.
   */
  focalModel: boolean;
  /** Lines either side of the focus that receive full credit. */
  focalSpanLines: number;
  /** Distance from the focus at which credit reaches `peripheralFloor`. */
  focalDecayLines: number;
  /** Credit floor for lines far from the focus, in [0,1]. */
  peripheralFloor: number;
  /** Minimum focal weight a line needs before a dwell is credited to it. */
  dwellFocalMin: number;
  /**
   * How many lines' worth of reading one second of attention buys. A tick's
   * focused time is a budget shared by every visible line in proportion to
   * its focal weight, scaled by this — time is conserved, never duplicated
   * across the viewport. 2 means a line must hold roughly a second of your
   * pace per line before it is read; 40 lines take at least 40 s.
   */
  attentionLines: number;
  /** Scale the time thresholds by how much reading each line actually costs. */
  contentScaling: boolean;
  /** Token count treated as one average line's worth of reading. */
  baselineTokens: number;
  /** Clamp for the per-line read-cost multiplier. */
  minReadCost: number;
  maxReadCost: number;
  /** Gap after which returning to a line counts as a new viewing episode. */
  revisitGapMs: number;
  /** Return visits needed before the revisit point is earned. */
  revisitsForPoint: number;
  /** Discard visibility credit while scrolling faster than a human reads. */
  readingSpeedGuard: boolean;
  maxLinesPerSecond: number;
  /**
   * Focused ms (at average read cost) before a line counts as read. Credit
   * grows linearly up to this, so a line seen for half of it is half read —
   * there is no "read on exposure".
   */
  readAckMs: number;
  /** Focused ms at which a line's focus credit stops growing. */
  focusCapMs: number;
  /** No caret, scroll or edit for this long and screen time stops counting. */
  idleAfterMs: number;
  /** Weights for the optional composite of the three separate metrics. */
  finalWeights: { read: number; focus: number; activity: number };
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
  weights: { visible: 1, focused: 1, dwell: 1, caret: 1, edited: 2, revisit: 1 },
  visibleMsForPoint: 300,
  focusedMsForPoint: 800,
  dwellMs: 1000,
  focalModel: true,
  focalSpanLines: 2,
  focalDecayLines: 10,
  peripheralFloor: 0.05,
  dwellFocalMin: 0.5,
  attentionLines: 2,
  contentScaling: true,
  baselineTokens: 8,
  minReadCost: 0.25,
  maxReadCost: 2.5,
  revisitGapMs: 20_000,
  revisitsForPoint: 1,
  readingSpeedGuard: true,
  maxLinesPerSecond: 45,
  readAckMs: 2000,
  focusCapMs: 8000,
  idleAfterMs: 30_000,
  finalWeights: { read: 0.6, focus: 0.25, activity: 0.15 },
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
    finalWeights: { ...base.finalWeights, ...(patch.finalWeights ?? {}) },
    pathRules: patch.pathRules ?? base.pathRules,
    contentRules: patch.contentRules ?? base.contentRules,
    ignore: patch.ignore ?? base.ignore,
  };
}

export function maxPoints(w: SignalWeights): number {
  return w.visible + w.focused + w.dwell + w.caret + w.edited + w.revisit;
}
