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
  let current: FileDiff | null = null;
  let newLine = 0;
  let hunkHadDeletion = false;
  let hunkAdded: number[] = [];

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
      continue;
    }
    if (!current) continue;

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
      current.file = raw.slice('rename to '.length).trim();
      continue;
    }

    const m = HUNK.exec(raw);
    if (m) {
      flushHunk();
      newLine = parseInt(m[3], 10);
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
    // Everything else (index lines, mode lines, "\ No newline") is ignored.
  }
  flushHunk();

  return files.filter((f) => f.addedLines.length > 0 || f.deletedLines > 0 || f.binary);
}

function stripPrefix(p: string): string {
  const unquoted = p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p;
  return unquoted.replace(/^[ab]\//, '');
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
