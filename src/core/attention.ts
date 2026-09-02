import type { BlindspotConfig } from './config';

/**
 * Attention shaping — the part of the model that compensates for not having an
 * eye tracker.
 *
 * Blindspot only ever observes IDE events: which lines are on screen, where
 * the caret is, when the viewport stopped moving. Two facts about human
 * reading are well established and are *invisible* in those events, so we
 * model them explicitly rather than pretend they do not exist:
 *
 *  1. Attention is local. The perceptual span in reading is a few lines wide
 *     and it sits where the reader is working. Crediting every line of a
 *     60-line viewport equally is the single largest source of false
 *     "reviewed" verdicts in a viewport-based model.
 *  2. Lines are not equal units of reading. Fixation count scales with the
 *     number of tokens, so `}` and a 140-character expression cannot honestly
 *     share one time threshold.
 *
 * Both are approximations. Both are configurable, and both can be turned off
 * (`focalModel`, `contentScaling`) to recover the flat viewport model, which
 * is what makes the difference measurable instead of asserted.
 */

/**
 * The share of one tick's attention a line at `line` plausibly received, given
 * that the reader's focus was at `focus`.
 *
 * Flat inside the perceptual span, decaying linearly to `peripheralFloor` at
 * `focalDecayLines`, and never zero — a line on screen has *some* chance of
 * having been read, and claiming otherwise would be as much of a lie as
 * claiming it certainly was.
 */
export function focalWeight(line: number, focus: number, cfg: BlindspotConfig): number {
  if (!cfg.focalModel) return 1;
  const distance = Math.abs(line - focus);
  if (distance <= cfg.focalSpanLines) return 1;
  const decay = Math.max(1, cfg.focalDecayLines - cfg.focalSpanLines);
  const t = Math.min(1, (distance - cfg.focalSpanLines) / decay);
  return 1 - (1 - cfg.peripheralFloor) * t;
}

/**
 * Where the reader's attention sits in a viewport, in 1-based line numbers.
 *
 * The caret is the best proxy the editor gives us — it is where the last
 * deliberate act happened. When it is off screen (you scrolled away from it)
 * the viewport centre is the honest fallback.
 */
export function focusLine(caretLine: number, firstVisible: number, lastVisible: number): number {
  if (caretLine >= firstVisible && caretLine <= lastVisible) return caretLine;
  return Math.round((firstVisible + lastVisible) / 2);
}

/**
 * How much reading one line costs, relative to an average line of code.
 *
 * Eye-tracking studies of reading — prose and code alike — find fixation
 * counts tracking token count and word length, not line count. A fixed
 * `visibleMsForPoint` therefore over-credits `}` and under-credits a dense
 * expression. We estimate tokens from identifier runs plus operators (which
 * are cheaper to fixate, hence the half weight) and scale the time thresholds
 * by the result.
 */
export function readCost(text: string, cfg: BlindspotConfig): number {
  if (!cfg.contentScaling) return 1;
  const trimmed = text.trim();
  if (trimmed.length === 0) return cfg.minReadCost;
  const words = trimmed.match(/[A-Za-z0-9_$]+/g)?.length ?? 0;
  const symbols = trimmed.replace(/[A-Za-z0-9_$\s]/g, '').length;
  const tokens = words + symbols * 0.5;
  const ratio = (tokens / Math.max(1, cfg.baselineTokens)) * shapeDiscount(trimmed);
  return Math.min(cfg.maxReadCost, Math.max(cfg.minReadCost, ratio));
}

/**
 * Lines whose shape tells you what they say before you have read them.
 *
 * Token count over-charges the boilerplate every reviewer skims on sight: an
 * import, `const x = 1`, a field in a type, a comment. These are recognised
 * rather than read, so the read time they need is discounted on top of the
 * token estimate. The patterns are deliberately conservative — a declaration
 * whose right-hand side is a call or an expression is real code and pays full
 * price, because that is where the bug is.
 * ponytail: regex shape guesses; swap for a tokenizer if a language needs it.
 */
const LITERAL =
  /(?:-?\d[\d_.]*|'[^']*'|"[^"]*"|`[^`]*`|true|false|null|undefined|None|nil|\[\]|\{\}|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/
    .source;
const SHAPES: Array<[RegExp, number]> = [
  // imports / requires / package & using lines
  [/^(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|using\b|package\b|#include\b|require\s*\()/, 0.4],
  // a declaration of a literal, an identifier or a bare `new X()`
  [
    new RegExp(
      String.raw`^(?:export\s+)?(?:const|let|var|val|final|static|private|public|protected|readonly|int|long|float|double|bool|boolean|string|String|auto)\b[\w\s<>\[\],|?:]*=\s*(?:new\s+[\w.]+\(\)|${LITERAL})\s*[;,]?$`,
    ),
    0.5,
  ],
  // a field or parameter in a type / interface / struct
  [/^(?:readonly\s+|public\s+|private\s+|protected\s+)?[A-Za-z_$][\w$]*\??\s*:\s*[\w<>\[\]|.'"`\s?()]+[;,]?$/, 0.6],
  // comments and doc lines
  [/^(?:\/\/|\/\*|\*|#(?!include|define|if|else|endif))/, 0.6],
  // single-keyword statements and lone closers
  [/^(?:return|break|continue|pass|else|try|finally|default:?|end)\s*[;:{}]*$/, 0.3],
];

/** Factor applied to a line's read cost for its shape, in (0,1]. */
export function shapeDiscount(trimmed: string): number {
  for (const [re, factor] of SHAPES) if (re.test(trimmed)) return factor;
  return 1;
}

/** Focal context handed to the ledger so crediting stays a pure function. */
export interface FocalContext {
  /** 1-based line the reader's attention is assumed to sit on. */
  line: number;
  /** Sum of focal weights over every visible line; the budget's denominator. */
  norm: number;
  cfg: BlindspotConfig;
}

/**
 * The share of one tick's attention a visible line gets, in [0,1].
 *
 * The tick is a budget: `attentionLines` lines' worth of time, split across
 * the viewport by focal weight. With the caret held still, the lines under
 * it get most of it and the far edge of the screen almost none; with 60
 * lines on screen nobody read them all in the same second.
 */
export function attentionShare(line: number, focus: FocalContext): number {
  const w = focalWeight(line, focus.line, focus.cfg);
  if (focus.norm <= 0) return w;
  return Math.min(1, (w / focus.norm) * focus.cfg.attentionLines);
}

/** Denominator for `attentionShare`: total weight of what is on screen. */
export function attentionNorm(ranges: Array<[number, number]>, focusLine: number, cfg: BlindspotConfig): number {
  let sum = 0;
  for (const [a, b] of ranges) for (let l = a; l <= b; l++) sum += focalWeight(l, focusLine, cfg);
  return sum;
}
