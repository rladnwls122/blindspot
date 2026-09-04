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
export function readCost(text: string, cfg: BlindspotConfig, file?: string): number {
  if (!cfg.contentScaling) return 1;
  const trimmed = text.trim();
  if (trimmed.length === 0) return cfg.minReadCost;
  const words = trimmed.match(/[A-Za-z0-9_$]+/g)?.length ?? 0;
  const symbols = trimmed.replace(/[A-Za-z0-9_$\s]/g, '').length;
  const tokens = words + symbols * 0.5;
  const ratio = (tokens / Math.max(1, cfg.baselineTokens)) * shapeDiscount(trimmed, file);
  return Math.min(cfg.maxReadCost, Math.max(cfg.minReadCost, ratio));
}

/**
 * Lines whose shape tells you what they say before you have read them.
 *
 * Token count over-charges the boilerplate every reviewer skims on sight: an
 * import, `const x = 1`, a field in a type, a comment. These are recognised
 * rather than read, so the read time they need is discounted on top of the
 * token estimate.
 *
 * Three rules govern the patterns below and the order they run in:
 *
 *  1. A false discount is worse than a missed one. Charging full price for a
 *     line somebody could have skimmed costs them a second; discounting a line
 *     that hides a bug is this tool reporting that they read something they
 *     did not. So `TRAPS` runs first and wins, and anything uncertain stays at
 *     full price.
 *  2. Shape decides only where shape decides content. A right-hand side
 *     holding a call, an operator or a condition is code, whatever it looks
 *     like.
 *  3. No language detection. These are regexes over one line, so only shapes
 *     that several languages share are worth having.
 *
 * The tiers come from `docs/superpowers/specs/2026-09-03-low-read-cost-line-shapes.md`:
 * T1 a lone keyword, T2 a dependency declaration, T3 a literal assignment or a
 * simple return, T4 a type field, a comment or a log. Lines that are pure
 * structure need no pattern — the token estimate already puts `}` on the floor.
 * ponytail: regex shape guesses; swap for a tokenizer if a language needs it.
 */

const T1 = 0.3;
const T2 = 0.4;
const T3 = 0.5;
const T4 = 0.6;

/** A literal, a dotted identifier, or an empty collection. */
const LITERAL =
  /(?:-?\d[\d_.]*[a-zA-Z]*|'[^']*'|"[^"]*"|`[^`]*`|true|false|True|False|null|undefined|None|nil|NULL|\[\]|\{\}|\(\)|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/
    .source;

/**
 * Lines that look simple and are not. Checked before every discount, so a
 * match here ends it: full price.
 *
 * Each entry is one row of the spec's trap table. They are deliberately wide —
 * over-trapping asks somebody to spend another second on a line they had
 * already understood, which is the cheap direction to be wrong in.
 */
const TRAPS: RegExp[] = [
  // Credentials. A declaration is boilerplate right up until it is this one.
  /\b(?:secret|secrets|token|tokens|password|passwd|apikey|api_key|credential|credentials|private_?key|keystore|key|keys|auth|jwt|oauth|session|cookie|signing|cipher|encrypt|decrypt)\b/i,
  // Defaults and branching: `a || b`, `a ?? b`, `c ? x : y`. A ternary needs
  // something between the marks, so `id?: number` stays a type field.
  /\|\||&&|\?\?|\?[^:?]+:/,
  // A comparison, which makes the line a condition however short it is.
  /===|!==|==|!=|<=|>=|=\s*!/,
  // Control flow, all of it.
  /^(?:if|elif|elsif|else\s+if|while|for|foreach|switch|match|case|when|unless|guard|until)\b|^case\b.*:$/,
  // State somebody else owns. `this.x = …` is delegation and is discounted
  // below; `config.retries = 3` reaches into another object.
  /^(?!this\.|self\.)[A-Za-z_$][\w$]*\.[\w$.]+\s*=[^=]/,
  // Destructive.
  /\b(?:delete|drop|DROP|rm|unlink|truncate|kill|destroy|purge|revoke)\b/,
  // Concurrency: the order and the interleaving are the content.
  /\b(?:await|async|spawn|goroutine|Thread|thread|mutex|Mutex|lock|Lock|atomic|volatile|defer)\b|\.then\b|\byield\s+\S/,
  // A suppressed check. The line says "do not look here", so look here.
  /\b(?:unsafe|as\s+any|@ts-ignore|@ts-expect-error|eslint-disable|noqa|prettier-ignore)\b|type:\s*ignore|#\[allow\(/,
  // A swallowed error.
  /\b(?:catch|except|rescue)\b\s*(?:\([^)]*\))?\s*[:{]?\s*(?:pass|nil|null|\{\s*\}|;)?\s*$|^_\s*[,=]\s*(?:err|error)\b/,
  // A one-line permission answer: `return canEdit;` is a whole access rule.
  /^return\s+(?:can|is|has|allow|permit|should|may|must)[A-Z_]/,
  // What a module makes public.
  /^(?:export\s+default|module\.exports\s*=)/,
];

/** A comment carrying one of these is an instruction to the reader, not prose. */
const WARNING_COMMENT =
  /\b(?:TODO|FIXME|HACK|XXX|BUG|SAFETY|WARNING|DANGER|DEPRECATED|eslint-disable|noqa|prettier-ignore|istanbul\s+ignore|c8\s+ignore)\b|@ts-ignore|@ts-expect-error|type:\s*ignore/;

/**
 * A comment line. A preprocessor directive is not one — `#include` is a
 * dependency and `#if` is control flow — and neither is a Rust attribute, a
 * shebang, or the close of a block comment.
 */
const COMMENT =
  /^(?:\/\/|\/\*|\*(?!\/)|#(?!include|define|if|else|elif|endif|ifdef|ifndef|pragma|!|\[)|--(?!\s*$)|<!--|%(?!\{)|"{3}|'{3})/;

const DISCOUNTS: Array<[RegExp, number]> = [
  // The exception: an import that binds no name is a side effect. Why is it here?
  [/^import\s+['"][^'"]+['"];?$/, T3],

  // A dependency or module declaration: a list of names to scan, not read.
  [
    /^(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|using\b|use\s+[A-Z\w:\\]|pub\s+use\b|mod\s+\w+;|extern\s+crate\b|package\b|namespace\b|#include\b|#pragma\s+once\b|require\s*\(|require\s+['"]|require_relative\b|require_once\b|source\s+\S|alias\s+[A-Z]|part\s+of\b|module\s+\w+\s+where\b|@import\b|@use\b|global\s+using\b)|^(?:const|let|var)\s+[\w{}\s,:*]+=\s*require\s*\(/,
    T2,
  ],

  // A lone keyword, and the closers of block-structured languages.
  [
    /^(?:return|break|continue|pass|else|try|finally|default|do|begin|end|fi|done|esac|endif|endfor|endwhile|yield|throw|raise|Ok\(\)|Ok\(\(\)\)|None|nil|null|true|false|True|False)\s*[;:{}()]*$/,
    T1,
  ],

  // A declaration whose value is a literal, an identifier or a bare `new X()`.
  [
    new RegExp(
      String.raw`^(?:export\s+|pub\s+)?(?:const|let|var|val|final|static|private|public|protected|internal|readonly|int|uint|long|short|float|double|bool|boolean|char|str|string|String|auto)\b[\w\s<>\[\],|?:&*'.]*=\s*(?:new\s+[\w.:<>]+\(\)|[\w.:<>]+::new\(\)|${LITERAL})\s*[;,]?$`,
    ),
    T3,
  ],
  // The same without a keyword: `MAX = 3`, `$max = 3;`, `x := 0`, `@count = 0`.
  // The name must be plain; a dotted left-hand side was trapped above.
  [
    new RegExp(
      String.raw`^[@$]?[A-Za-z_][\w$]*(?:\s*:\s*[\w<>\[\]|.]+)?\s*:?=\s*(?:new\s+[\w.:<>]+\(\)|${LITERAL})\s*[;,]?$`,
    ),
    T3,
  ],
  // A declaration with no value at all: `var name string`, `int count;`.
  [
    /^(?:pub\s+|private\s+|public\s+|protected\s+|static\s+|final\s+)*(?:var|let|val|int|uint|long|short|float|double|bool|boolean|char|string|String)\b[\w\s<>\[\]*&,]*;?$/,
    T3,
  ],

  // Delegation: the line hands one name straight to another.
  [/^(?:this|self)\.[\w$]+\s*=\s*[\w$]+\s*[;,]?$/, T3],
  [/^(?:get|set)\s+[\w$]+\s*\([^)]*\)\s*\{\s*return\s+(?:this|self)\.[\w$]+;?\s*\}?$/, T3],
  [/^(?:public|private|protected)?\s*[\w<>\[\]]+\s+get[A-Z]\w*\(\)\s*\{\s*return\s+[\w$.]+;\s*\}$/, T3],
  [/^fun\s+\w+\(\)\s*=\s*[\w$.]+$/, T3],
  [/^def\s+\w+\(self\):\s*return\s+self\.[\w$]+$/, T3],

  // A return of a literal or a plain name. `return a + b;` is not this.
  [new RegExp(String.raw`^(?:return|Ok|Some|Err)\s*\(?\s*(?:${LITERAL}|this|self)\s*\)?\s*[;,]?$`), T3],

  // A field in a type, an interface or a struct.
  [
    /^(?:readonly\s+|public\s+|private\s+|protected\s+|pub\s+|pub\(crate\)\s+)?[A-Za-z_$][\w$]*\??\s*:\s*[\w<>\[\]|.'"`\s?()=&*-]+[;,]?$/,
    T4,
  ],
  // A Go struct field, with or without its tag: Name string `json:"name"`
  [/^[A-Z]\w*\s+\*?\[?\]?[\w.\[\]*]+(?:\s+`[^`]*`)?$/, T4],
  // A C or C++ struct member: `int count;`, `char* name;`.
  [/^(?:unsigned\s+|signed\s+|const\s+)?[A-Za-z_]\w*\s*\*?\s*[A-Za-z_]\w*(?:\[\d*\])?;$/, T4],
  // An enum member: `Red,` `RED = 'red',` `Active = 1,` `Foo(u32),`
  [new RegExp(String.raw`^[A-Z]\w*(?:\([\w<>,\s]*\))?(?:\s*=\s*${LITERAL})?,$`), T4],

  // A comment. Warning comments never reach here.
  [COMMENT, T4],

  // A log line whose arguments are string literals and nothing else.
  [
    /^(?:(?:console|logger|log|Log|logging|fmt|System\.out|System\.err)\.\w+|print|println|printf|print!|println!|echo|puts|NSLog)!?\s*\(?\s*(?:[A-Z_]+\s*,\s*)?(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\)?\s*;?$/,
    T4,
  ],

  // A decorator, annotation or attribute with no arguments, and the one-line
  // prologues that open a file.
  [
    /^(?:@[\w.]+(?:\(\))?|#\[[\w:]+(?:\([\w\s,]*\))?\]|\[\w+\]|'use strict';?|"use strict";?|#!\/|<\?php|\?>)$/,
    T3,
  ],

  // The skeleton of a test. The description is read; the structure is not.
  [
    /^(?:describe|context|it|test|suite|beforeEach|afterEach|beforeAll|afterAll|setUp|tearDown)\s*\(\s*(?:(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*)?(?:\([^)]*\)|function\s*\([^)]*\))?\s*(?:=>)?\s*\{?$/,
    T3,
  ],
  [/^#\[test\]$|^func\s+Test\w*\(t\s+\*testing\.T\)\s*\{$|^@pytest\.fixture$|^def\s+test_\w+\(self\):$/, T3],
];

/**
 * Cheap shapes that mean something only once the file type is known.
 *
 * A bare `SELECT` is a keyword in a `.sql` file and a string in a `.ts` one,
 * so these tables are keyed by extension. Each carries its own traps — the
 * spec's "expensive" column — because a config file's dangerous lines look
 * nothing like a program's.
 */
const BY_EXTENSION: Array<{ file: RegExp; traps: RegExp[]; shapes: Array<[RegExp, number]> }> = [
  {
    // Structured data: a key and a scalar. A script folded into a value is not.
    file: /\.(?:json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties)$/i,
    traps: [/\$\{|\|\s*$|>\s*$|<<[-~]?[A-Z]/],
    shapes: [
      [new RegExp(String.raw`^"?[\w.$-]+"?\s*[:=]\s*(?:${LITERAL})\s*,?$`), T3],
      [/^\[[\w.$"'-]+\]$|^-\s+[\w.$/-]+$/, T3],
    ],
  },
  {
    // One property, one value.
    file: /\.(?:css|scss|sass|less|styl)$/i,
    traps: [/\bcalc\(|\bvar\(\s*[^)]*,|@media\b|@supports\b|!important/],
    shapes: [[/^[-\w]+\s*:\s*[^;{}]+;$/, T3]],
  },
  {
    // A clause on its own line. Anything that filters or writes is not.
    file: /\.sql$/i,
    traps: [/\b(?:WHERE|JOIN|UPDATE|INSERT|MERGE|UNION|HAVING|CASE)\b/i],
    shapes: [
      [/^(?:SELECT|FROM\s+[\w.]+|ORDER\s+BY\s+[\w.,\s]+|GROUP\s+BY\s+[\w.,\s]+|LIMIT\s+\d+);?$/i, T3],
    ],
  },
  {
    // Image, workdir, port. `RUN` and `ENTRYPOINT` are programs.
    file: /(?:^|[\\/])Dockerfile(?:\.\w+)?$/i,
    traps: [/^(?:RUN|ENTRYPOINT|CMD|COPY\s+--from)\b/i],
    shapes: [[/^(?:FROM|WORKDIR|EXPOSE|USER|ARG|ENV|LABEL|VOLUME|STOPSIGNAL)\s+\S+/i, T3]],
  },
  {
    // A target header or a declaration. A recipe line is indented, and is code.
    file: /(?:^|[\\/])(?:GNUm|M|m)akefile$|\.mk$/,
    traps: [/^\t/],
    shapes: [[/^(?:\.PHONY:|\.DEFAULT_GOAL\s*:?=|[\w.$/%-]+:(?:\s+[\w.$/%-]+)*)$/, T3]],
  },
  {
    // A tag with no attributes, or a self-closing one. A handler is code.
    file: /\.(?:html?|jsx|tsx|vue|svelte|astro)$/i,
    traps: [/\bon[A-Z]\w+\s*=|dangerouslySetInnerHTML|\{[^}]*\}/],
    shapes: [[/^<\/?[A-Za-z][\w.-]*\s*\/?>$/, T3]],
  },
];

/**
 * Factor applied to a line's read cost for its shape, in (0,1].
 *
 * `file` is the path the line lives in, when the caller knows it. It unlocks
 * the shapes that only make sense for one kind of file.
 */
export function shapeDiscount(trimmed: string, file?: string): number {
  if (trimmed.length === 0) return 1;

  // A comment is prose, and cheap — unless it is a warning, the one kind of
  // comment that exists to be acted on.
  if (COMMENT.test(trimmed)) return WARNING_COMMENT.test(trimmed) ? 1 : T4;

  for (const trap of TRAPS) if (trap.test(trimmed)) return 1;

  if (file !== undefined) {
    const table = BY_EXTENSION.find((t) => t.file.test(file));
    if (table) {
      for (const trap of table.traps) if (trap.test(trimmed)) return 1;
      for (const [re, factor] of table.shapes) if (re.test(trimmed)) return factor;
    }
  }

  for (const [re, factor] of DISCOUNTS) if (re.test(trimmed)) return factor;
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
