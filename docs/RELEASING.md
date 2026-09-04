# Releasing

What is left between a green branch and a published extension. Everything here
except the last step is already done for 0.4.0.

## Before

- `npm ci && npm test` — the whole suite, on the version of Node CI uses.
- `npm run demo` — the scripted session still produces a report. `test/readme.test.ts`
  already asserts that the card in both READMEs is the one the model prints, so a
  retune that moves the numbers fails the suite rather than making the front page lie.
- `npm run package` — builds the `.vsix` and is the only check that the manifest,
  the icon and `.vscodeignore` agree. Delete the file afterwards; it is gitignored.
- The version in `package.json` and the top dated section of `CHANGELOG.md` match.
- You are on the default branch. The READMEs use relative links (`docs/PLAN.md`,
  `src/core/attention.ts`, …) and `vsce` rewrites them against the repository at
  the branch you publish from, so publishing from a feature branch produces links
  that break the moment the branch is deleted.

## Publish

```bash
npx vsce login rladnwls122     # once per machine; needs a Marketplace PAT
npm run publish                # tsc, then vsce publish --no-dependencies
```

`npm run publish` publishes the version in `package.json`. It does not bump
anything, so the number is whatever the release commit says.

The personal access token comes from an Azure DevOps organisation, scoped to
**Marketplace → Manage**, and is not a GitHub token. It expires; when publishing
fails with a 401 that is almost always why.

## After

```bash
git tag -a v0.4.0 -m "0.4.0" && git push origin v0.4.0
```

Then add an `## [Unreleased]` heading back to the top of `CHANGELOG.md` for the
next cycle.

## Version numbers

The marketplace has no notion of pre-release inside a version string, so
`0.4.0-rc.1` is not available. Patch for fixes only, minor for anything that adds
a command, a setting or a measurement.

## What is not automated, and why

There is no publish step in CI. Publishing puts a build in front of other people
under this account's name, and the token that does it would have to live in the
repository's secrets to make it automatic. The build is reproducible from any
checkout, so the only thing automation would save is one command.
