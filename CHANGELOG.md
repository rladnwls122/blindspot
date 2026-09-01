# Changelog

## [Unreleased]

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
