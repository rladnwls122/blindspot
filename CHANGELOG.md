# Changelog

## [Unreleased]

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

### Fixed

- The pre-commit hook was always written to `.git/hooks`, so in a repository
  that sets `core.hooksPath` — which husky does by default — it installed a
  hook git would never run. The hooks directory now comes from git config.
- The hook did nothing at all when neither `blindspot` was on PATH nor
  `node_modules` held a copy, which is the situation right after installing
  from a `.vsix`. It now falls back to the extension's bundled CLI, and says
  so on stderr when it can find nothing — a silent hook reads as "your diff
  is fine".
- File text for the report is cached across refreshes and invalidated by mtime
  and size. A large diff now costs a stat per file every few seconds instead
  of a full read.
- Marking a file reviewed no longer records evidence under a path the report
  cannot look up (an untitled buffer, a diff view, a file from another
  repository).
- A mistyped CLI flag, an unknown command, or a non-numeric threshold is an
  error (exit 2) instead of a silent full run against different settings than
  the caller asked for.

- Commands no longer fail with "command not found" outside a git repository.
  They register regardless, explain what is missing, and retry once a
  repository appears — `git init` in an already-open folder now just works.
- A multi-root workspace with the repository in any position other than first
  is now detected.
- A failure during startup surfaces as a message instead of a silently dead
  extension.
- `npm test` runs on Windows (the npm script's glob never expanded there), and
  the pre-commit hook's executable-bit assertion is skipped on a platform that
  has no executable bit.

## [0.1.0]

First working version: the evidence model, the risk model, the report panel,
the status bar, the `blindspot` CLI and the pre-commit hook.
