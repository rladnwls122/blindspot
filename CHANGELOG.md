# Changelog

## [Unreleased]

### Added

- **Two modes, switchable.** `Diff` measures the lines you changed; `Reading`
  measures every line of every file you open. The switch is
  `Blindspot: Switch Mode`, `Blindspot: Toggle Diff / Reading Mode`, and the
  status bar; the setting behind it is `blindspot.mode` (`auto` / `diff` /
  `reading`). What a diff is measured against is `Blindspot: Choose What the
  Diff Is Measured Against` — the last completed review, `blindspot.baseRef`,
  or a ref you type — stored as `blindspot.diffSince`. The commit-time warning
  measures the diff whatever mode the panel is in, so a reading session cannot
  switch it off by accident.
- **The mouse as a second focus sensor.** The hover request VS Code makes when
  the pointer stops over a token is the one place the API says where the mouse
  is. The tracker now takes whichever of caret and mouse moved more recently as
  the focus of the attention budget (a scroll invalidates the mouse, since the
  text under it moved), and a mouse rest counts as the same *navigated* signal
  a caret placement does. Reading with the mouse while the caret sits at the
  top of the file used to credit the wrong lines; it no longer does. Stored as
  `pointerHits`; the hover explanation shows `n× caret, m× mouse`.
- **Interacted lines.** Of the lines called reviewed, the report counts those
  the reader also touched (caret, mouse, keystrokes) apart from those that
  passed on screen time alone. Status bar, sidebar and CLI all show it.
- **Reading pace.** Attention is a conserved budget, so the focused time
  credited to the target lines recovers the time spent on them, and lines per
  minute follows. Past the 300–500 lines/hour at which review studies see
  defect detection fall off, the CLI flags the pace as `fast`.
- **Deleted lines are shown.** Still never scored — you cannot fail to read a
  line that is gone — but each file now says how many lines it removed, and
  the report carries the total.
- **A sidebar.** *Blindspot* under Source Control: the headline, then every
  file with unread code worst first, with the exact ranges beneath. Clicking
  goes there; the inline check marks a file reviewed. Built from a pure tree
  model in `src/core/tree.ts`, so its ranking and wording are unit-tested.
- `blindspot read` — the CLI counterpart of Reading mode: every file with
  reading evidence, whole. Needs a folder, not a repository. `blindspot report`
  now prints the Read / Focus / Activity / Pace block too.
- **A commit trailer.** `blindspot install-hook --trailer` also installs a
  `prepare-commit-msg` hook, and every commit made afterwards carries
  `Blindspot: 36% (66/182 lines unread)` — the share of its staged diff that
  was unread when it went in. Evidence lives in `.git` and dies with the clone;
  the trailer travels with the commit, which makes it the data the validation
  experiment needs: when a bug is fixed, was the line behind it unread at the
  time? Opt-in, because unlike the evidence this one number leaves the
  repository. Merge, squash and amend messages are left alone; a rewritten
  message gets one trailer, not two; and when the editor is about to open the
  trailer sits below the subject line the way `git commit -s` places its own.
  `blindspot check --staged --trailer` prints the line by itself.
- **The line-shape catalogue, implemented.** How long a line must hold your
  focus before it counts as read scales with how much reading it actually
  costs, and the catalogue in
  `docs/superpowers/specs/2026-09-03-low-read-cost-line-shapes.md` is now in
  the model in full: dependency declarations, literal assignments, `this.x =
  x` delegation, a return of a literal, struct and enum members across Go,
  Rust and C, string-only log lines, argument-less annotations, test
  skeletons, and per-file-type shapes for JSON, YAML, CSS, SQL, Dockerfiles,
  Makefiles and JSX.
  The half that matters is the trap list, which runs first and wins: a line
  carrying a credential, a default, a comparison, control flow, a mutation of
  somebody else's state, a destructive verb, concurrency, a suppressed check,
  a swallowed error, a one-line permission answer or a default export pays
  full price however simple its shape. A comment is cheap; a comment saying
  `TODO`, `SAFETY`, `@ts-ignore` or `noqa` is not, because it exists to be
  acted on. Every entry has a should-be-cheap and a must-not-be-cheap test.
- **A way out of the reading denominator.** Reading mode measures every file
  you have opened, so one 3,000-line vendored file opened by accident took over
  the number and stayed for a month, until the prune. `Blindspot: Stop
  Measuring This File`, the sidebar's inline bin, and `blindspot forget <path>`
  drop a file or a folder: the evidence is deleted, and the path is remembered
  as forgotten, because a file still open in a tab would earn fresh evidence
  within seconds and be back in the denominator before anyone looked. That list
  lives beside the evidence in the state, not in the committed
  `.blindspot/config.json` — it is one person saying what they are not reading,
  which is the same kind of fact as the evidence, and belongs in the same
  private place. `blindspot forget --list` shows it and `--undo` reverses it.
- `blindspot read <path>` narrows the reading report to one file or folder, as
  the design called for. Without a path it is unchanged.
- A `meta.json` beside the state of a folder that is not a repository, naming
  the folder it belongs to and when it was last written. `~/.blindspot/` is a
  set of twelve-hex-character directories; without this, nobody can tell what
  one is for or whether deleting it loses anything. Repositories get none —
  `.git/blindspot` explains itself.
- Mode-aware gutter marks: orange (red where risky) for an unread changed
  line, blue for a line you simply have not got to yet while reading.

### Changed

- The Review Score row that said `AI-generated` now says `Machine-written`, in
  the CLI, the report panel and the demo alike. The sidebar and the hover
  already used that name, and it is the honest one: an editor can see that a
  line arrived in bulk or was declared by a tool, not that a model wrote it.
  What the bucket counts is unchanged.
- `Blindspot: Show Review Report` now opens the interactive page that used to
  be the demo (`demo/index.html`), fed the evidence of your own session: the
  threshold slider re-judges every line of the current target in the browser,
  from the same per-line signals the status bar and the git hook judge it by.
  Later reports are posted into the page, so the slider and scroll position
  survive the refresh that runs every few seconds. The page's file list opens a
  file at its first unread line; its card button jumps to the next unread hunk.
  The panel's `mark read` and `Complete review` buttons are gone; both remain
  as palette commands, and the sidebar marks a file reviewed inline.
- The page's verdict follows the model exactly: a line needs enough signals
  *and* either a human edit or enough focused time. The demo used to accept the
  signals alone, which is why it reported 64% for a session the extension
  scores at 55%.
- The page template moved from `demo/page.template.html` to `media/page.html`
  so that it ships in the `.vsix`.
- `blindspot.target` (four values) became `blindspot.mode` (three);
  `unreviewed` folded into `diff` with `blindspot.diffSince` deciding the base.
- `Blindspot: Mark Current File As Reviewed` is `Blindspot: Mark File As
  Reviewed`, and accepts a file from the sidebar; `Toggle Unreviewed
  Highlighting` is `Toggle Unread Line Markers`.
- The periodic refresh — two git processes plus a report rebuild — is skipped
  while the window is not focused and nothing is unsaved, since no evidence is
  collected in that state. Regaining focus refreshes immediately, so a commit
  made in a terminal shows up as soon as you come back.

### Fixed

- `diff.submodule=diff` and a `.gitattributes` textconv filter no longer put
  lines nobody can read into the report. The first inlines a submodule's own
  diff, whose paths belong to another repository and exist nowhere in this
  working tree; the second shows converted text rather than the lines on
  screen. Either way the report carried lines no evidence could ever attach
  to. The diff is now requested with `--submodule=short --no-textconv`.
- A user's `diff.mnemonicPrefix` or `diff.noprefix` setting no longer changes
  what gets measured. The parser strips the standard `a/` and `b/` from the
  diff header; with mnemonic prefixes every file came back as `w/src/…`, a
  path that exists nowhere, so no evidence anchored and the report named the
  wrong file, and with no prefix a directory really called `b` lost its name.
  The diff is now requested with the standard prefixes pinned, whatever the
  configuration says.
- `install-hook` in a linked worktree (`git worktree add`) now installs where
  git runs hooks. It wrote into the worktree's own git directory,
  `.git/worktrees/<name>/hooks`, which git never reads — the hook was
  reported as installed and never ran once. The hooks directory now comes from
  `git rev-parse --git-path hooks`, which also covers `core.hooksPath`.
- Renaming a file or folder in the editor no longer forgets that you read it.
  Evidence is keyed by path, so a rename stranded everything recorded under the
  old name: in Reading mode the file vanished from the report, and it came back
  entirely unread. The tracker now follows the editor's rename event and moves
  the evidence with the lines — a folder rename carries every file beneath it,
  and evidence that arrives under a name already open is anchored and merged
  rather than dropped.
- A submodule bump or a symlink retarget no longer shows up as an unread line.
  Their diff "lines" are a commit hash and a link target, nothing an editor
  opens, so the report carried an unread line that could never be cleared and
  a commit that only moved a submodule pointer scored 0%. The parser now reads
  the new side's mode from the header and leaves gitlinks and symlinks out; a
  symlink that becomes a regular file is text and is measured. An untracked
  symlink is likewise skipped instead of being read through to its target.
- A file whose name has a non-ASCII character — `src/한글.ts` — no longer
  breaks the whole measurement. git quotes such a path in the diff header with
  octal escapes of its UTF-8 bytes; the parser tried to read that as a JSON
  string and threw, and the error surfaced as "git diff against HEAD failed"
  for every file in the repository: nothing measured, and an enforcing hook
  blocked the commit. Paths are now unquoted the way git quotes them, on either
  side of a rename and in `rename to` lines too.
- The editor was collecting evidence under different focal defaults than the
  CLI, the tests and the docs: `package.json` still declared
  `focalSpanLines` 5 / `focalDecayLines` 24 / `peripheralFloor` 0.2 /
  `idleAfterMs` 60 s, and VS Code hands a declared default back for an unset
  setting, so the code's 2 / 10 / 0.05 / 30 s never applied inside the editor.
  The two now agree, and the README's config example says the real numbers.
- `npm test` runs on Node 22 as well as 20 (and on Windows): the test files
  are listed by a small runner instead of relying on `node --test <dir>`.
- A file that was deleted or renamed after the report was built made "Review
  Blindspot" and the file links fail with a generic error. Both now say the
  file moved and refresh the report instead of failing on it again.
- A command that throws now reports its own error message, not VS Code's
  generic "command failed" naming the id.
- A controller that failed partway through startup kept its command ids
  registered, so the fallback handlers could not take them back and VS Code
  rejected the second registration. The controller now owns and releases
  everything it registered.
- Turning `blindspot.enabled` off left the last report on screen in the
  sidebar and the markers as if it were live. Both now clear, and the sidebar
  says tracking is off.

## [0.3.1] — 2026-09-01

### Added

- Tests that the report webview escapes what it renders. Much of the panel's
  content is not ours — file paths come out of `git diff`, and a repository can
  contain a file named anything a filesystem allows — and the webview runs
  scripts. Escaping was correct; now a future unescaped interpolation fails
  loudly instead of being caught by eye.

### Fixed

- Panel messages carrying a path outside the repository are ignored. The
  webview only ever sends back paths the extension put into its own HTML, but
  a handler that joins an arbitrary string onto the repo root and opens the
  result is the wrong thing to leave lying around.

## [0.3.0] — 2026-09-01

### Added

- Hovering an unread line explains the verdict: which of the six signals it
  earned, which it did not, and the risk that ranked it. The model could always
  explain a single line — `explain()` had no caller — and a coverage number
  nobody can interrogate is a number nobody believes.
  `blindspot.explainOnHover`.

### Fixed

- A controller that failed partway through startup left its tick interval and
  file watcher running — a background process nobody could see, in an extension
  that had just reported itself as not running.

## [0.2.0] — 2026-09-01

### Added

- **Focal weighting** (`src/core/attention.ts`). A tick of screen time is no
  longer handed equally to every line in the viewport; it decays with distance
  from the caret (the viewport centre when the caret is scrolled off screen)
  down to a floor rather than to zero. Dwell is credited the same way, because
  a stationary viewport is evidence that you stopped somewhere, not everywhere.
  Configurable via `blindspot.focalModel`, `focalSpanLines`, `focalDecayLines`
  and `peripheralFloor`; turning it off restores the flat viewport model.
- **Per-line read cost.** The visibility and focus time thresholds now scale
  with a line's estimated token count, so a closing brace and a 140-character
  expression stop sharing one threshold. `blindspot.contentScaling`.
- **`revisit`, a sixth evidence signal.** Returning to a line after
  `blindspot.revisitGapMs` (default 20 s) counts as a new viewing episode. It
  only earns its point on top of real focused time, so a file scrolled past
  twice in a background split earns nothing.
- Korean `README.md` with the prior-work section (Begel et al., GANDER,
  CodeGRITS, The GitHub Gaze, Vouch) that places the project against the
  eye-tracking literature it approximates. English moved to `README.en.md`.
- `npm run package` / `npm run publish` (`@vscode/vsce`), a generated
  marketplace icon (`npm run icon`), and CI on Linux and Windows.
- `blindspot --version`.
- Tests for the parts that need `vscode` and therefore had none: activation
  (`test/activation.test.ts`) and the attention collector itself
  (`test/tracker.test.ts`), which now asserts the guards the honesty of the
  whole tool rests on — nothing counted while the window is unfocused, nothing
  counted while scrolling faster than anyone reads, no credit for the far edge
  of a tall viewport, and a closed laptop is not an hour of diligent reading.

### Fixed

- Commands no longer fail with "command not found" outside a git repository.
  They register regardless, explain what is missing, and retry once a
  repository appears — `git init` in an already-open folder now just works.
- A multi-root workspace with the repository in any position other than first
  is now detected, and a failure during startup surfaces as a message instead
  of a silently dead extension.
- The pre-commit hook was always written to `.git/hooks`, so in a repository
  that sets `core.hooksPath` — which husky does by default — it installed a
  hook git would never run. The hooks directory now comes from git config.
- The hook did nothing at all when neither `blindspot` was on PATH nor
  `node_modules` held a copy, which is the situation right after installing
  from a `.vsix`. It now falls back to the extension's bundled CLI, and says so
  on stderr when it can find nothing — a silent hook reads as "your diff is
  fine".
- File text for the report is cached across refreshes and invalidated by mtime
  and size. A large diff now costs a stat per file every few seconds instead of
  a full read.
- Marking a file reviewed no longer records evidence under a path the report
  cannot look up (an untitled buffer, a diff view, a file from another
  repository).
- A mistyped CLI flag, an unknown command, or a non-numeric threshold is an
  error (exit 2) instead of a silent full run against settings the caller never
  asked for.
- `npm test` runs on Windows (the npm script's glob never expanded there), and
  the pre-commit hook's executable-bit assertion is skipped on a platform that
  has no executable bit.

## [0.1.0]

First working version: the evidence model, the risk model, the report panel,
the status bar, the `blindspot` CLI and the pre-commit hook.
