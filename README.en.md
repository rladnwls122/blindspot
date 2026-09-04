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
│ Review coverage     55%         │
│ Blindspot           45% ⚠       │
│                                 │
│  182 changed lines              │
│  101 reviewed                   │
│   81 unseen                     │
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
| caret | you put the cursor on it, selected it, or **your mouse came to rest on it** | 1 |
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

**The mouse as a second gaze sensor.** Approximating focus with the caret alone
misses the most common way code gets read: caret parked at the top, scrolling
and pointing with the mouse. All the credit lands near the caret and the lines
actually read stay blindspots. VS Code does not expose the pointer, but it
calls hover providers when the pointer stops over a token — the one place the
API lets slip where the mouse is, and mouse-gaze correlation is a long-measured
fact in HCI. So a hover request does two things: whichever of caret and mouse
moved *more recently* becomes the focus of the attention budget (a scroll
invalidates it, since the text under a still mouse has moved), and it counts as
the same *navigated* signal a caret placement does, reported apart in the hover
explanation as `1× caret, 2× mouse`. With `editor.hover.enabled` off the sensor
is simply absent and the caret model is what remains.

**Saying how much to trust the number.** Of the lines called reviewed, the ones
the reader touched — caret, mouse, keystrokes — are counted apart from the ones
that passed on screen time alone, and the pace is reported too: attention is a
conserved budget of `attentionLines` line-seconds per second, so the focused
time credited to the target lines divided by that throughput recovers roughly
the time spent. Past the 300–500 lines an hour at which review studies see
defect detection collapse, the pace is flagged `fast` — meaning distrust the
coverage next to it. Deleted lines are still never scored, but every file now
shows its `−12 deleted`, because a quietly removed null check is where the bug
is.

[`test/attention.test.ts`](test/attention.test.ts) and
[`test/tracker.test.ts`](test/tracker.test.ts) replay the same sessions through
both models and assert where they disagree.

### You have to be able to ask why

A coverage number nobody can interrogate is a number nobody believes. Hovering
an unread line shows exactly which signals it earned and which it did not:

```
blindspot — 2/3 pts
✓ on screen (5000ms)
✓ focused (5000ms)
· paused (0×)
· navigated (0× caret, 0× mouse)
· edited (0×)
· re-read (0× returned)
· read time 5.0s of 2.0s (100%)
```

When "but I did read that" collides with the model's verdict, this is where it
gets settled — and where the model gets corrected. `blindspot.explainOnHover`.

## Two modes: Diff and Reading

One engine, one report; only the target differs. Switch from the status bar,
`Blindspot: Switch Mode`, or `Blindspot: Toggle Diff / Reading Mode`.

| | Diff | Reading |
| --- | --- | --- |
| target | the lines you changed — since the last completed review, else since `baseRef` (HEAD) | every line of every file you have opened in this folder |
| headline | **36% unread** — a question still open | **62% read** — progress |
| gutter | orange, red where risky | blue |
| Review Score | yes | no — new-code and risk weighting mean nothing for a codebase |
| needs | git | a folder |

In diff mode `Blindspot: Choose What the Diff Is Measured Against` picks the
base: the last completed review, `baseRef`, or any ref. `Complete Review` moves the baseline
to HEAD.

**The commit-time warning always measures the diff**, whatever mode the panel
is in. A reading session silently switching that warning off was the one real
risk of having a switch at all, so staging computes a diff report of its own.

The sidebar (**Blindspot**, under Source Control) lists files with unread code,
worst first, with the exact ranges beneath each; clicking one goes there.

### Moving the definition

The report panel is the same page as [`demo/index.html`](demo/index.html); the
only difference is that its data is this session's evidence. Drag the slider to
change the point threshold for "read", and coverage, the file ranking and the
Review Score are recomputed in the browser — from the same per-line signals the
extension records. Nothing is saved: to change the definition, set
`blindspot.reviewThresholdPoints`, or edit the team-wide `.blindspot/config.json`.

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

████░░░░░░ 43

Coverage         55%
Critical         21%     ← this is why the score is 43 and not 55
New code         55%
Machine-written  43%
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
npm run package                              # produces blindspot-0.3.1.vsix
code --install-extension blindspot-0.3.1.vsix
```

Open a git repository and coverage appears in the status bar, and in the
Blindspot view in the Activity Bar. Outside one the commands still register and
tell you what is missing.

To work on it:

```bash
npm install
npm run build
npm test           # 221 tests: the model, the CLI, a real git repo, the extension
npm run demo       # replay a scripted session through the real model
npm run demo:page  # regenerate demo/index.html — the interactive version
npm run icon       # regenerate media/icon.png
```

To debug the extension: open this folder in VS Code and press <kbd>F5</kbd>.

[`demo/index.html`](demo/index.html) is the same report with the threshold made
adjustable: move the slider and every number on the page — coverage, the file
ranking, the Review Score — recomputes from the same per-line signals the
extension records. It is generated from `media/page.html`, so the
numbers in it can never drift from the model.

### Commands

| command | what it does |
| --- | --- |
| `Blindspot: Show Review Report` | the panel above |
| `Blindspot: Switch Mode (Diff / Reading)` | what to measure |
| `Blindspot: Choose What the Diff Is Measured Against` | last review / `baseRef` / any ref |
| `Blindspot: Review Blindspot` | jump to the next unread hunk, worst risk first |
| `Blindspot: Mark File As Reviewed` | "I read this in the GitHub UI" (also from the sidebar) |
| `Blindspot: Stop Measuring This File` | take a file you opened by accident out of the denominator |
| `Blindspot: Complete Review` | baseline to HEAD — reviewed up to here |
| `Blindspot: Install pre-commit Hook` | print the card at commit time |
| `Blindspot: Toggle Unread Line Markers` | gutter markers |
| `Blindspot: Reset Review Evidence` | start over |

### CLI

```bash
blindspot check --staged            # print the card for what you are about to commit
blindspot report                    # per-file table plus Read / Focus / Activity / Pace
blindspot read                      # what Reading mode sees: opened files, whole. No git needed
blindspot read src/core             # just one file or folder of it
blindspot forget vendor/            # out of the denominator: evidence deleted, and kept out
blindspot forget --list             # what you have forgotten; --undo <path> reverses it
blindspot check --min-coverage 70   # exit 1 below 70% (for CI or a strict hook)
blindspot check --json              # machine-readable
blindspot check --staged --trailer  # the commit trailer line: Blindspot: 36% (66/182 lines unread)
blindspot install-hook --trailer    # also install prepare-commit-msg, which writes it on every commit (opt-in)
blindspot --version                 # the version
```

The installed pre-commit hook **warns and exits 0** by default. A review tool
that blocks commits gets uninstalled within a week; one that tells you something
true gets kept. Enforcement is opt-in via `--min-coverage` / `--max-critical`.

The commit trailer is **opt-in** too. Evidence stays in `.git` and dies with the
clone; the trailer is the one number that leaves the repository with the commit.
In return it is the only record that can later answer "was the line behind this
bug fix unread when it went in?" — the experiment that decides whether this
metric means anything. Merge, squash and amend messages are left alone, and
`--no-verify` does not switch it off: that flag skips checks, and this is a
record, not a check.

## Configuration

Editor settings live under `blindspot.*`. `blindspot.mode` (`auto` / `diff` /
`reading`) and `blindspot.diffSince` (`lastReview` / `baseRef`) are written for
you by the panel and the commands; the rest are the model's knobs. Project-wide
rules — what counts as risky in *this* codebase — go in a committed
`.blindspot/config.json`, so a team shares one definition:

```json
{
  "reviewThresholdPoints": 3,
  "minCoverage": 70,
  "maxCriticalBlindspotLines": 0,
  "focalModel": true,
  "focalSpanLines": 2,
  "focalDecayLines": 10,
  "peripheralFloor": 0.05,
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
  coverage.ts      diff × evidence → report (with interacted lines, pace, deletions)
  score.ts         the composite
  labels.ts        the words the panel, status bar, sidebar and CLI share
  tree.ts          the sidebar as data — tested without vscode
src/extension/   the editor glue (tracker, panel, tree, decorations, git)
src/cli/         `blindspot` — the hook and CI entry point
demo/            replay a scripted session through the real model
```

The `core` boundary is deliberate: the definition of "read" has to be
retunable and replayable without an editor attached, or it can never be
validated.

## Known limits

- Focus is approximated by the caret and the mouse. Reading somewhere neither
  of them is remains the largest error term, the one an eye tracker would
  close; and the mouse sensor exists only while `editor.hover` is enabled.
- With focus in the terminal or a panel, VS Code still reports the last editor
  as active. That time can accrue to the few lines around the caret until
  `idleAfterMs` (30 s) runs out.
- Read cost estimates tokens, not difficulty. Short hard lines are undervalued.
- Review that happens off screen (the GitHub UI, a pair session) is invisible,
  which is what `Mark Current File As Reviewed` exists for.
- Every error leans toward *under*-reporting coverage. Being told to read
  something twice is a better failure than being told you read it.

## Status

Unreleased, after v0.3.1 — the two modes, the interactive page as the panel,
the sidebar, the mouse sensor, interacted lines and pace are on `main`.
See [`CHANGELOG.md`](CHANGELOG.md) for what changed and
[`docs/BRAINSTORM.md`](docs/BRAINSTORM.md) (Korean) for the reasoning about
what else to measure and build. See [`docs/PLAN.md`](docs/PLAN.md) for what is
next and [`docs/QUESTIONS.md`](docs/QUESTIONS.md) for the decisions still open.

## License

MIT
