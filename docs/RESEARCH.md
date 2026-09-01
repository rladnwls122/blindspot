# What does it mean to have read a line of code?

This is the question the project is actually about. Everything else — the panel,
the risk model, the git hook — is a way of making the answer visible. If the
answer is wrong, the tool is a lie with a progress bar on it.

## The current answer

Six observable signals, weighted, with a threshold. The whole model is
[`evaluate()`](../src/core/evidence.ts), and it is deliberately small enough to
argue with:

```
visible   on screen ≥ 300 ms × the line's read cost              +1
focused   on screen in the active editor, window focused ≥ 800ms +1
dwell     viewport held still ≥ 1 s near your focus              +1
caret     the cursor was placed on it, or a selection covered it +1
edited    a human keystroke changed it                           +2
revisit   left, then came back and read it again (needs focused) +1

reviewed  ≥ 3 points
```

Three of those lines carry an approximation that
[`attention.ts`](../src/core/attention.ts) makes explicit, because the editor
cannot see where you looked and pretending otherwise is the fastest way to
report coverage nobody earned:

- **visibility is shaped, not broadcast** — credit decays with distance from the
  caret to a floor, instead of being handed equally to every line in a viewport
- **a line is not a unit of reading** — fixation counts follow tokens, so the
  time thresholds scale with the line's estimated token count
- **dwell is local** — a stationary viewport says you stopped somewhere, not
  everywhere, so only lines near the focus are credited

All of it is switchable (`focalModel`, `contentScaling`), which is the point:
a correction you cannot turn off is a belief, not a measurement.

The threshold of 3 is not arbitrary. It is the smallest number that makes all
three of these true at once, which is the specification the model was written
against:

| behaviour | points | verdict |
| --- | --- | --- |
| scrolling over a line | 1 | not reviewed |
| a line visible for 0.2 s | 0 | not reviewed |
| visible, paused, navigated to | 3 | reviewed |

These are executable: `test/evidence.test.ts` fails if a future model breaks any
of them.

## What the model refuses to count

Three guards matter more than the weights, because each one closes a way for the
tool to flatter you:

**Unfocused time is worth nothing.** Not "worth less" — nothing. A file left open
in a background split for an hour earns 1 point (visibility) and never reaches
the threshold. Without this rule, leaving VS Code open overnight would report a
perfectly reviewed diff.

**Scrolling faster than reading speed is worth nothing.** Above 45 lines/second
the viewport contributes no visibility credit at all. Flinging the scrollbar
through a 2,000-line file is not 2,000 lines of review, and a model that says
otherwise is worse than no model.

**Ticks longer than two seconds are discarded.** A closed laptop, a debugger
pause, or a suspended container would otherwise credit hours of "reading" to
whatever was on screen when time stopped.

**Jumping to a blindspot does not clear it.** "Review Blindspot" moves the cursor
into the hunk, so caret credit is suppressed for 800 ms after the jump.
Otherwise the button that shows you what you missed would mark it as read.

## The line-identity problem

Evidence cannot be stored against a line number. Insert one import at the top of
a file and every number below shifts, silently transferring "I read this" from
the line you read to the line you didn't. That is not a rounding error; it is the
tool reporting the opposite of the truth.

So evidence is anchored to a hash of the line's content
([`hash.ts`](../src/core/hash.ts)), with line numbers used only as a live
in-memory index. Two consequences follow, and both are deliberate:

- **Reindenting keeps your evidence.** The hash trims surrounding whitespace, so
  a formatter run does not erase your memory of reading the file.
- **Changing a token destroys it.** New content is unread content, even if it
  looks similar. `applyChange` also wipes accumulated eye-time on any line whose
  text was rewritten: time spent on the old text does not vouch for the new.

Identical lines (`}`, `});`, blank lines) are the hard case, because content
alone cannot distinguish the third closing brace from the first. Each stored
entry therefore also carries the index it was recorded at, and re-anchoring
matches per hash group by proximity to that index rather than in file order. A
block that *moved* still keeps its evidence — reading code and then moving it
does not make it unread.

Every ambiguous case resolves toward "no evidence", because the safe failure
direction is asking you to read something again.

## What this definition still gets wrong

Known, unfixed, and worth being honest about:

1. **Eyes ≠ viewport.** VS Code gives us the visible range, not gaze. A line at
   the bottom edge of a 60-line viewport is counted the same as the line you
   were staring at. Mitigation: dwell and caret carry a lot of the weight.
   Possible fix: weight by distance from the caret or the viewport centre.

2. **Reading ≠ understanding.** Nothing here can tell "read carefully" from "read
   while thinking about lunch". The claim is bounded on purpose: Blindspot
   reports what you *could not possibly* have reviewed, not what you understood.
   The false-negative direction (flagging something you did read) is a nuisance;
   the false-positive direction (claiming you read what you skipped) is fatal, so
   the model is tuned to be stingy.

3. **Review happens elsewhere.** GitHub's web UI, a pair-programming session, a
   printout. This is why `Mark Current File As Reviewed` exists — an explicit
   override is better than a model that quietly counts those hours as blindspot.

4. **Deleted lines are unmeasured.** You cannot fail to read a line that is no
   longer there — but a deletion can absolutely be the bug. Right now deletions
   are counted and not scored. Open question: should reviewing a deletion require
   looking at the *old* text, which means rendering a real diff view?

5. **The weights are guesses.** Reasonable ones, but guesses. Nobody has
   validated that a 1-second dwell is where "skimming" turns into "reading", and
   it plainly varies by person, language, and line density.

## How to find out whether the model is right

The scoring model is pure, deterministic, and separated from the collector
specifically so it can be validated offline. The path:

**Step 1 — record sessions.** Persist the raw evidence stream (already the
storage format: evidence, never verdicts) so a session can be replayed under a
different model. `demo/simulate.ts` is the replay harness; it drives the real
ledger with scripted eye-movement and prints the real report.

**Step 2 — get ground truth.** Have developers review a diff normally, then ask
per hunk: *did you actually read this?* Their answer is the label. A few hundred
labelled hunks is enough to see whether the threshold is in the right place.

**Step 3 — tune against the labels, not against vibes.** Report precision and
recall separately, and treat them asymmetrically: a false "reviewed" is much more
expensive than a false "blindspot", so optimise recall of blindspots at a fixed,
tolerable false-alarm rate.

**Step 4 — the only outcome measure that matters.** Do bugs concentrate in code
that Blindspot flagged as unread? Take a repo's bug-fix commits, walk back to the
commit that introduced each bug, and check whether those lines were in a
blindspot at the time. If unread lines are not meaningfully more likely to
contain the bug, then the metric is decoration and should be abandoned.

That last experiment is the one that decides whether this is a real metric or a
pretty one. It is worth running early.

## The claim, stated precisely

> Blindspot does not measure comprehension. It measures whether the physical
> preconditions for review were met, and it is deliberately conservative about
> saying they were.

Anything stronger than that is not supported by what an editor can observe.
