import type { FileDiff } from './types';

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0 --no-color` into per-file changed-line sets.
 *
 * We only care about line numbers in the *new* file, because that is what the
 * editor shows and what the ledger indexes. Deletions are counted but not
 * tracked: you cannot fail to read a line that is no longer there. (Whether you
 * should have to review deletions is an open question — see docs/RESEARCH.md.)
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  /** Submodule pointers: they are in the diff, but they are not files here. */
  const gitlinks = new Set<FileDiff>();
  let current: FileDiff | null = null;
  let newLine = 0;
  let hunkHadDeletion = false;
  let hunkAdded: number[] = [];
  /** Past the first `@@` of this file, where every line is content. */
  let inHunk = false;

  const flushHunk = () => {
    if (!current) return;
    if (hunkHadDeletion) current.modifiedLines.push(...hunkAdded);
    hunkAdded = [];
    hunkHadDeletion = false;
  };

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushHunk();
      const path = parseDiffGitPath(raw);
      current = { file: path, addedLines: [], modifiedLines: [], deletedLines: 0, binary: false };
      files.push(current);
      newLine = 0;
      inHunk = false;
      continue;
    }
    if (!current) continue;

    const m = HUNK.exec(raw);
    if (m) {
      flushHunk();
      newLine = parseInt(m[3], 10);
      inHunk = true;
      continue;
    }

    // Inside a hunk every line is content, whatever it looks like. A deleted
    // SQL comment arrives as `--- comment` and a deleted `-- x` as `--- x`;
    // read as file headers they were dropped, so the deletion went uncounted
    // and the lines that replaced it never counted as modified.
    if (!inHunk) {
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        current.binary = true;
        continue;
      }
      // `+++ b/path` is the authoritative new path (handles renames and quoting).
      if (raw.startsWith('+++ ')) {
        const p = raw.slice(4).trim();
        if (p !== '/dev/null') current.file = stripPrefix(p);
        continue;
      }
      if (raw.startsWith('--- ')) continue;
      if (raw.startsWith('rename to ')) {
        current.file = unquote(raw.slice('rename to '.length).trim());
        continue;
      }
      // Mode 160000 is a gitlink: bumping a submodule prints `+Subproject
      // commit <sha>` as an added line, and that line is in no file anyone can
      // open. Counted, it was an unread line that could never be read — a
      // blindspot the reader had no way to close.
      if (raw.endsWith(' 160000')) {
        gitlinks.add(current);
        continue;
      }
      // Anything else in a header (index, mode, similarity) is not content.
      continue;
    }

    if (raw.startsWith('+')) {
      current.addedLines.push(newLine);
      hunkAdded.push(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      current.deletedLines++;
      hunkHadDeletion = true;
    } else if (raw.startsWith(' ')) {
      newLine++;
    }
    // Everything else in a hunk ("\ No newline at end of file") is not a line.
  }
  flushHunk();

  return files.filter(
    (f) => !gitlinks.has(f) && (f.addedLines.length > 0 || f.deletedLines > 0 || f.binary),
  );
}

function stripPrefix(p: string): string {
  return unquote(p).replace(/^[ab]\//, '');
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Undo git's path quoting.
 *
 * Git wraps a path in quotes as soon as it holds anything unusual and escapes
 * it C-style — non-ASCII bytes as octal (`"\355\225\234.ts"`), quotes and
 * backslashes with a backslash. This used to be read as JSON, and JSON has no
 * octal escape: one Korean file name in the diff threw, and the throw was not
 * per-file — the whole report became "git diff failed" for every file in it.
 *
 * The escapes are bytes of UTF-8, not characters, so they are decoded as bytes
 * and the result is read back as UTF-8 once, at the end.
 */
export function unquote(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; ) {
    const next = body.indexOf('\\', i);
    // A run with no escape in it is already text; take its bytes whole, so a
    // character outside the basic plane is not split down the middle.
    if (next < 0) {
      bytes.push(...Buffer.from(body.slice(i), 'utf8'));
      break;
    }
    if (next > i) bytes.push(...Buffer.from(body.slice(i, next), 'utf8'));
    const c = body[next + 1];
    if (c === undefined) {
      // A trailing backslash is not an escape; keep it rather than drop it.
      bytes.push(0x5c);
      break;
    }
    const octal = body.slice(next + 1, next + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i = next + 4;
      continue;
    }
    if (c in ESCAPES) bytes.push(ESCAPES[c]);
    else bytes.push(...Buffer.from(c, 'utf8'));
    i = next + 2;
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseDiffGitPath(line: string): string {
  // `diff --git a/x b/x`, with quoting when the path has spaces.
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^"(.+)" "(.+)"$/);
  if (quoted) return stripPrefix(`"${quoted[2]}"`);
  const half = Math.floor(rest.length / 2);
  const a = rest.slice(0, half).trim();
  const b = rest.slice(half).trim();
  if (a && b) return stripPrefix(b);
  return stripPrefix(rest.split(' ').pop() ?? rest);
}

/** Union two diffs of the same tree (e.g. staged + unstaged). */
export function mergeDiffs(a: FileDiff[], b: FileDiff[]): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  for (const list of [a, b]) {
    for (const d of list) {
      const existing = byFile.get(d.file);
      if (!existing) {
        byFile.set(d.file, {
          file: d.file,
          addedLines: [...d.addedLines],
          modifiedLines: [...d.modifiedLines],
          deletedLines: d.deletedLines,
          binary: d.binary,
        });
        continue;
      }
      existing.addedLines = dedupeSorted([...existing.addedLines, ...d.addedLines]);
      existing.modifiedLines = dedupeSorted([...existing.modifiedLines, ...d.modifiedLines]);
      existing.deletedLines += d.deletedLines;
      existing.binary = existing.binary || d.binary;
    }
  }
  return [...byFile.values()];
}

function dedupeSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((x, y) => x - y);
}
