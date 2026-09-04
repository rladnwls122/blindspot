# Blindspot

Blindspot measures which lines of code a person's eyes have actually rested on, and reports the share it cannot vouch for. The glossary below is the language the code, the reports, the docs and the issues all use; where the interface says something different from the code, that difference is named here.

## Language

### What is measured

**Target**:
The set of lines a report is about. In diff mode the lines you changed; in reading mode every line of every file you have opened here.
_Avoid_: scope, subject, tracked lines

**Signal**:
One observable fact about a line — that it was on screen, in the focused editor, held still, navigated to, edited, or returned to. Six of them exist.
_Avoid_: metric, event

**Evidence**:
Everything observed about one line, stored raw as durations and counts rather than as a verdict, so a changed definition of reading can be replayed over history.
_Avoid_: score, data, stats

**Read line**:
A target line whose evidence clears the review threshold and which was either edited by hand or looked at for long enough. Both halves are required.
_Avoid_: reviewed line, seen line, covered line

**Unread line**:
A target line that is not a read line.
_Avoid_: unreviewed line, unseen line, missed line

**Blindspot**:
The share of the target that is unread. Also the name of the tool, and never used to mean a single line.
_Avoid_: uncovered, gap, debt

**Review threshold**:
The number of signal points a line needs before it can count as read. The definition of reading, expressed as one number.
_Avoid_: cutoff, limit

**Interacted line**:
A read line the person also touched — caret, mouse rest, or keystroke — as opposed to one that passed on screen time alone. Counted apart so the report can say how far to trust itself.
_Avoid_: active line, confirmed line

**Machine-written line**:
A line that arrived in bulk rather than a keystroke at a time, or that a tool declared as agent-written. The honest name: an editor cannot know that a language model wrote a line, so the interface says this too and never "AI-generated", which would claim more.
_Avoid_: AI line, generated line, LLM code

**Risk**:
How much it matters to get a line wrong, from its path and its content. Ranks the report; never mixed multiplicatively with volume, because forty unread lines of prose must not outrank three unread lines of authentication.
_Avoid_: severity, priority, weight

### What the person sees

**Report**:
One target scored under one definition of reading, at one moment. Everything the panel, the status bar, the sidebar, the CLI and the git hook show comes from a single report, so they cannot disagree.
_Avoid_: summary, dashboard, results

**Walk**:
Stepping through unread lines one at a time, the way Find steps through matches, and the only time reading markers are on screen. Markers stay off during ordinary editing; a Walk goes top to bottom inside a file and visits files worst risk first.
_Avoid_: navigation, tour, jump, next-hunk

**Marker**:
The editor-surface indication that a line is unread. Never a change to the colour of the code itself.
_Avoid_: decoration, highlight

**Baseline**:
The commit a completed review ended at. Everything after it counts as not yet reviewed.
_Avoid_: since, anchor, checkpoint

**Mode**:
Which target a report measures — diff or reading. The commit-time warning always measures the diff, whatever mode is showing.
_Avoid_: target setting, view

**Trailer**:
The one line a commit carries about its own blindspot — `Blindspot: 36% (66/182 lines unread)` — written by the opt-in prepare-commit-msg hook. The only measurement that leaves the repository, and the only one that outlives the clone.
_Avoid_: footer, annotation, stamp

### Standing refusals

These are part of the language because they are load-bearing product decisions, not defaults awaiting reconsideration.

**No remote transmission**:
Attention data is personal data and stays inside the git directory. Nothing is uploaded. The trailer is the one deliberate exception: a single aggregate per commit, never a line, and only when asked for.

**No AI-only tracking**:
The problem is code nobody read, not code a machine wrote. Authorship is one submetric, never the subject.

**Warn, never block**:
The pre-commit hook warns and exits zero. Enforcement is opt-in behind a coverage threshold, because a review tool that blocks commits gets removed within a week.

**No gamification**:
No badges, streaks or leaderboards. A measurement that becomes a target gets optimised, and a person scrolling slowly to raise a number has broken the instrument.
