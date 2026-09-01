# Blindspot

[![CI](https://github.com/rladnwls122/blindspot/actions/workflows/ci.yml/badge.svg)](https://github.com/rladnwls122/blindspot/actions/workflows/ci.yml)

**Blindspot is a developer-attention measurement tool for code review.**

> `git blame` tells you who *wrote* a line. Blindspot tells you who *read* it.

A VS Code extension that estimates which lines of your diff your attention
actually rested on — from IDE events alone, no eye tracker — and tells you,
right before you commit, how much of it you never read.

*[한국어 README](README.md)*

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

## Prior work

"Where does a developer actually look during code review" is a question the
literature has already measured — with dedicated eye trackers.
[Begel et al.](https://andrewbegel.com/papers/eye-movements-code-review.pdf)
tracked gaze through review sessions;
[GANDER](https://portal.research.lu.se/en/publications/gander-a-platform-for-exploration-of-gaze-driven-assistance-in-co)
and [Gazing at Code Review(s)](https://portal.research.lu.se/en/projects/gazing-at-code-reviews/)
build research platforms on top of it; [CodeGRITS](https://codegrits.github.io/CodeGRITS/)
records IDE events and gaze together, and needs a Tobii to do it.

The closest product is [Vouch](https://marketplace.visualstudio.com/items?itemName=sanzhardanybayev.vouch-review-coverage),
which manages *human review coverage* — but by attestation:

```text
Vouch      "I marked this code as reviewed."
             ↓
Blindspot  "Is there behavioural evidence that you read it?"
```

So the position is:

```text
Eye-tracking research
        ↓
Gaze during code review is measurable
        ↓
But dedicated eye trackers are impractical for everyday development
        ↓
Blindspot approximates review attention from IDE interaction signals
        ↓
And turns the result into actionable diff coverage
```

No hardware. No camera, no eye tracker, nothing leaves the machine.

## What counts as "read"

This is the actual research question of the project, and the entire model is
about 30 lines in [`src/core/evidence.ts`](src/core/evidence.ts). Six signals,
weighted, with a threshold:

| signal | meaning | points |
| --- | --- | --- |
| visible | on screen for ≥ 300 ms, scaled by how much the line costs to read | 1 |
| focused | on screen in the active editor, window focused, ≥ 800 ms | 1 |
| dwell | the viewport held still for ≥ 1 s while the line was near your focus | 1 |
| caret | you put the cursor on it or selected it | 1 |
| edited | you typed on it | 2 |
| revisit | you left it and came back to read it again | 1 |

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

## Getting closer without an eye tracker

Treating a viewport as a reading record is the model's biggest lie: the ten
lines around your caret and the bottom of a 60-line editor cannot have been
read at the same rate. Three corrections, all in
[`src/core/attention.ts`](src/core/attention.ts), all switchable so the
difference stays measurable rather than asserted:

**Focal weighting.** The perceptual span in reading is a few lines wide and it
follows the point of work, so a tick's credit decays with distance from the
caret (the viewport centre when the caret is scrolled away) instead of being
broadcast flat. It decays to a floor, not to zero — a line on screen had *some*
chance of being read, and saying zero is as much a lie as saying one. Dwell is
credited the same way: a stationary viewport is evidence you stopped
*somewhere*, not everywhere.

**Per-line read cost.** Fixation counts track token count, not line count, so
one 300 ms threshold over-credits `}` and under-credits a 140-character
expression. Tokens are estimated from identifier runs plus operators, and the
time thresholds scale with the result.

**Re-reading.** Regression is one of the strongest comprehension signals in the
code-reading literature. Returning to a line after 20 s counts as a new viewing
episode — but only earns its point on top of real focused time, or a file left
open in a background split would earn re-reading credit for being scrolled past
twice.

[`test/attention.test.ts`](test/attention.test.ts) replays the same session
through both models and asserts where they disagree.

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

To use it — build a `.vsix` and install that:

```bash
npm install
npm run package                              # produces blindspot-0.1.0.vsix
code --install-extension blindspot-0.1.0.vsix
```

Open a git repository and coverage appears in the status bar. Outside one the
commands still register and tell you what is missing.

To work on it:

```bash
npm install
npm run build
npm test           # 160 tests: the model, the CLI, a real git repo, the extension
npm run demo       # replay a scripted session through the real model
npm run demo:page  # regenerate demo/index.html — the interactive version
npm run icon       # regenerate media/icon.png
```

To debug the extension: open this folder in VS Code and press <kbd>F5</kbd>.

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
blindspot --version                 # the version
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
  "focalModel": true,
  "focalSpanLines": 5,
  "focalDecayLines": 24,
  "peripheralFloor": 0.2,
  "contentScaling": true,
  "revisitGapMs": 20000,
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
  attention.ts     focal weighting, read cost, re-reading — the eye tracker's stand-in
  evidence.ts      six signals → points → reviewed
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

## Known limits

- Focus is approximated by the caret. Reading somewhere your cursor is not is
  the largest remaining error term, and the one an eye tracker would close.
- Read cost estimates tokens, not difficulty. Short hard lines are undervalued.
- Review that happens off screen (the GitHub UI, a pair session) is invisible,
  which is what `Mark Current File As Reviewed` exists for.
- Every error leans toward *under*-reporting coverage. Being told to read
  something twice is a better failure than being told you read it.

## Status

v0.1 — the model, the report, the panel, the CLI and the hook all work.
See [`docs/PLAN.md`](docs/PLAN.md) for what is next and
[`docs/QUESTIONS.md`](docs/QUESTIONS.md) for the decisions still open.

## License

MIT
