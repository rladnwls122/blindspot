#!/usr/bin/env bash
#
# Move blindspot/ out of the host repository and into a standalone one,
# keeping the commit history for these files only.
#
#   ./scripts/extract-repo.sh git@github.com:you/blindspot.git
#
# Run it from the blindspot/ directory. It does not modify the host repo.

set -euo pipefail

REMOTE="${1:-}"
if [ -z "$REMOTE" ]; then
  echo "usage: $0 <git-remote-url>" >&2
  echo "example: $0 git@github.com:rladnwls122/blindspot.git" >&2
  exit 2
fi

HOST_ROOT="$(git rev-parse --show-toplevel)"
PREFIX="$(git rev-parse --show-prefix)"
PREFIX="${PREFIX%/}"

if [ -z "$PREFIX" ]; then
  echo "error: already at the repository root; nothing to extract." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "extracting '$PREFIX' from $HOST_ROOT ($BRANCH)"

# History for this subtree only, rooted at the subtree's own top level.
SPLIT_SHA="$(cd "$HOST_ROOT" && git subtree split --prefix="$PREFIX" "$BRANCH")"
echo "subtree commit: $SPLIT_SHA"

git clone --no-checkout "$HOST_ROOT" "$WORK/repo" >/dev/null 2>&1
cd "$WORK/repo"
git checkout -q -b main "$SPLIT_SHA"
git remote remove origin
git remote add origin "$REMOTE"

echo
echo "ready in $WORK/repo — $(git rev-list --count HEAD) commit(s) on 'main'"
echo "review it, then:"
echo
echo "  cd $WORK/repo && git push -u origin main"
echo
echo "(the temp directory is removed when this script exits, so copy it first"
echo " if you want to keep it: cp -r $WORK/repo ~/blindspot)"
trap - EXIT
