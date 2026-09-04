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
      current.file = unquoteGitPath(raw.slice('rename to '.length).trim());
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

const C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
};

/**
 * Undo git's path quoting.
 *
 * With `core.quotePath` on — the default — git writes every byte outside
 * ASCII as a three-digit octal escape of the path's UTF-8 encoding, so
 * `src/한.ts` arrives as `"src/\355\225\234.ts"`; `"`, `\` and control
 * characters are C-escaped whatever the setting, and a path that needs none
 * of this arrives bare. Octal runs are collected and decoded as one UTF-8
 * sequence, since a single character spans several of them.
 *
 * JSON.parse used to do this job. It throws on the first octal escape, and
 * that exception surfaced as "git diff failed" for the whole repository: one
 * Korean file name, and nothing at all was measured.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  let out = '';
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length > 0) {
      out += new TextDecoder().decode(Uint8Array.from(bytes));
      bytes = [];
    }
  };
  const isOctal = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '7';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      flush();
      out += ch;
      continue;
    }
    if (isOctal(inner[i + 1])) {
      let oct = '';
      while (oct.length < 3 && isOctal(inner[i + 1])) oct += inner[++i];
      bytes.push(parseInt(oct, 8));
      continue;
    }
    flush();
    const next = inner[i + 1] ?? '';
    out += C_ESCAPES[next] ?? next;
    i++;
  }
  flush();
  return out;
}

function stripPrefix(p: string): string {
  return unquoteGitPath(p).replace(/^[ab]\//, '');
}

/** A quoted path as git writes it: `"` … `"` with backslash escapes inside. */
const NEW_PATH_QUOTED = / ("(?:[^"\\]|\\.)*")$/;
const OLD_PATH_QUOTED = /^"(?:[^"\\]|\\.)*" (.+)$/;

function parseDiffGitPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  // Either side may be quoted on its own: a rename from an ASCII name to a
  // Korean one quotes only the new path.
  const tail = NEW_PATH_QUOTED.exec(rest);
  if (tail) return stripPrefix(tail[1]);
  const head = OLD_PATH_QUOTED.exec(rest);
  if (head) return stripPrefix(head[1]);
  // Both bare. `a/x b/x` splits in the middle; a bare rename between names
  // with spaces is ambiguous here and is settled by the `rename to` or `+++`
  // line that follows.
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
