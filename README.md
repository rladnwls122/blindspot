# Blindspot

**`git blame` tells you who wrote a line. Blindspot tells you who read it.**

A VS Code extension that tracks which lines of your diff your eyes have actually
rested on, and tells you — right before you commit — how much of it you never read.

```
┌─────────────────────────────────┐
│     BLINDSPOT                   │
│                                 │
│ Review coverage     64%         │
│ Blindspot           36% ⚠       │
│                                 │
│  182 changed lines              │
│  116 reviewed                   │
│   66 unseen                     │
│                                 │
│ ⚠ CRITICAL                      │
│ src/auth/session.ts             │
│ lines 9-34 unread               │
│                                 │
│ [ Review Blindspot ]            │
└─────────────────────────────────┘
```

That card is not a mockup. Run `npm run demo` and the numbers come out of the
real scoring model replaying a scripted editing session.

## Why

We have a metric for how much of the code the *tests* touched. We have none for
how much of it a *person* looked at. That gap was survivable when writing code
was the slow part. It isn't anymore: a diff can now be produced faster than it
can be read, and the natural failure mode of AI-assisted work is a large, plausible,
unreviewed change that passes CI.

Blindspot measures the thing nobody measures: attention.

## What counts as "read"

This is the actual research question of the project, and the entire model is
about 30 lines in [`src/core/evidence.ts`](src/core/evidence.ts). Five signals,
weighted, with a threshold:

| signal | meaning | points |
| --- | --- | --- |
| visible | on screen for ≥ 300 ms | 1 |
| focused | on screen in the active editor, window focused, ≥ 800 ms | 1 |
| dwell | the viewport held still for ≥ 1 s while the line was on screen | 1 |
| caret | you put the cursor on it or selected it | 1 |
| edited | you typed on it | 2 |

A line is **reviewed** at 3 points. That threshold is chosen so the three
propositions the project started from are literally true — and they are asserted
as tests in [`test/evidence.test.ts`](test/evidence.test.ts):

```
scroll over line          →  1 pt   ≠ reviewed
visible for 0.2 sec       →  0 pts  ≠ reviewed
visible + pause + caret   →  3 pts  ≈ reviewed
```

Nothing is credited while the window is unfocused, while the viewport is moving
faster than a human reads (45 lines/sec by default), or across any tick longer
than two seconds — otherwise a closed laptop would report an hour of diligent
reading.

See [`docs/RESEARCH.md`](docs/RESEARCH.md) for what this definition gets wrong
and how to find out.

## Percentage alone is useless

36% unread means nothing on its own. Forty unread lines of README are fine;
three unread lines in `auth/session.ts` are not. So every changed line is also
classified by risk — from its path (`auth/`, `billing/`, `migrations/`,
`.github/workflows/`) and from its content (`eval(`, `process.env`, string-built
SQL, `innerHTML`) — and the report is ranked by risk first, volume second.

A comment inside a critical file is demoted one rank: you cannot ship an auth
bug in a comment.

The composite **Review Score** is coverage weighted by what the coverage was *of*:

```
Review Score

█████░░░░░ 49

Coverage       64%
Critical       24%     ← this is why the score is 49 and not 64
New code       64%
AI-generated   48%
```

Components with nothing to measure are dropped and their weight is redistributed,
so a diff that touches no critical code is not punished for having none.

## AI code is a bucket, not the product

Tracking only AI-generated code would make this a worse tool: the problem is
unreviewed code, whoever produced it. Every changed line is measured. Machine
authorship is reported *alongside* coverage, not instead of it.

Provenance records what was actually observed, never a guess about a model:

- `typed` — built up by human keystrokes
- `bulk` — arrived in one machine-speed insertion (an agent, a paste, a codemod)
- `declared-ai` — a tool explicitly claimed it via `.blindspot/ai-regions.json`
- `unknown` — predates tracking

## Install

```bash
npm install
npm run build
npm test           # 114 tests, 18 of them against a real git repository
npm run demo       # replay a scripted session through the real model
npm run demo:page  # regenerate demo/index.html — the interactive version
```

To run the extension: open this folder in VS Code and press <kbd>F5</kbd>.

[`demo/index.html`](demo/index.html) is the same report with the threshold made
adjustable: move the slider and every number on the page — coverage, the file
ranking, the Review Score — recomputes from the same per-line signals the
extension records. It is generated from `demo/page.template.html`, so the
numbers in it can never drift from the model.

### Commands

| command | what it does |
| --- | --- |
| `Blindspot: Show Review Report` | the panel above |
| `Blindspot: Review Blindspot` | jump to the next unread hunk, worst risk first |
| `Blindspot: Mark Current File As Reviewed` | "I read this in the GitHub UI" |
| `Blindspot: Install pre-commit Hook` | print the card at commit time |
| `Blindspot: Toggle Unreviewed Highlighting` | in-editor markers |
| `Blindspot: Reset Review Evidence` | start over |

### CLI

```bash
blindspot check --staged            # print the card for what you are about to commit
blindspot report                    # per-file table
blindspot check --min-coverage 70   # exit 1 below 70% (for CI or a strict hook)
blindspot check --json              # machine-readable
```

The installed pre-commit hook **warns and exits 0** by default. A review tool
that blocks commits gets uninstalled within a week; one that tells you something
true gets kept. Enforcement is opt-in via `--min-coverage` / `--max-critical`.

## Configuration

Editor settings live under `blindspot.*`. Project-wide rules — what counts as
risky in *this* codebase — go in a committed `.blindspot/config.json`, so a team
shares one definition:

```json
{
  "reviewThresholdPoints": 3,
  "minCoverage": 70,
  "maxCriticalBlindspotLines": 0,
  "pathRules": [
    { "pattern": "(^|/)payments/", "level": "critical", "reason": "money movement" }
  ]
}
```

## Where the data lives

`.git/blindspot/state.json` — inside the git directory, so it is per-clone, never
committed by accident, and deleted with the clone. Review attention is personal
telemetry about *you*; it must never end up in a shared branch. Nothing leaves
your machine.

Evidence is stored against a hash of each line's content, not its line number,
so inserting an import above a line you read does not hand that credit to a line
you didn't. Reindenting a line keeps its evidence; changing a token does not.

## Architecture

```
src/core/        the model — no vscode import, fully unit-tested
  evidence.ts      five signals → points → reviewed
  risk.ts          path + content → risk level
  ledger.ts        line identity across edits and reloads
  coverage.ts      diff × evidence → report
  score.ts         the composite
src/extension/   the editor glue (tracker, panel, decorations, git)
src/cli/         `blindspot` — the hook and CI entry point
demo/            replay a scripted session through the real model
```

The `core` boundary is deliberate: the definition of "read" has to be
retunable and replayable without an editor attached, or it can never be
validated.

## Status

v0.1 — the model, the report, the panel, the CLI and the hook all work.
See [`docs/PLAN.md`](docs/PLAN.md) for what is next and
[`docs/QUESTIONS.md`](docs/QUESTIONS.md) for the decisions still open.

## License

MIT
