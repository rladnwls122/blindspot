import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { buildReport, type ReportSources } from '../src/core/coverage';
import { buildTree, type FileNode, type SummaryNode } from '../src/core/tree';
import { baseLabel, headline, paceIsFast, paceLabel, shortRef } from '../src/core/labels';
import { emptyEvidence, type FileDiff, type LineEvidence } from '../src/core/types';

const cfg = DEFAULT_CONFIG;

function read(): LineEvidence {
  return { ...emptyEvidence(), visibleMs: 2000, focusedMs: 2000, dwellEvents: 1, caretHits: 1 };
}

function report(
  files: Record<string, { lines: string[]; changed: number[]; read?: number[] }>,
  opts: { mode?: 'diff' | 'reading'; sinceReview?: boolean; baseRef?: string } = {},
) {
  const diffs: FileDiff[] = Object.entries(files).map(([file, f]) => ({
    file,
    addedLines: f.changed,
    modifiedLines: [],
    deletedLines: 0,
    binary: false,
  }));
  const sources: ReportSources = {
    getText: (file) => files[file]?.lines,
    getEvidence: (file, line) => (files[file]?.read?.includes(line) ? read() : undefined),
  };
  return buildReport(diffs, sources, cfg, opts.baseRef ?? 'HEAD', 0, {
    mode: opts.mode,
    sinceReview: opts.sinceReview,
  });
}

/**
 * The sidebar is the report as a tree. It must rank the way the report ranks,
 * say what the report says, and point clicks at the first unread line — all
 * of which is checkable here, without an editor, because the nodes are data.
 */
describe('buildTree', () => {
  test('leads with the headline and lists files worst first, each with its unread ranges', () => {
    const r = report({
      'README.md': {
        lines: Array.from({ length: 40 }, () => 'docs'),
        changed: Array.from({ length: 40 }, (_, i) => i + 1),
      },
      'src/auth/session.ts': {
        lines: ['const token = sign(payload)', 'return token', 'export {}', 'done'],
        changed: [1, 2, 3, 4],
        read: [4],
      },
    });
    const nodes = buildTree(r);
    const summary = nodes[0] as SummaryNode;
    assert.equal(summary.kind, 'summary');
    assert.match(summary.label, /^\d+% unread$/);
    assert.match(summary.description, /since HEAD/);

    const first = nodes[1] as FileNode;
    assert.equal(first.kind, 'file');
    assert.equal(first.file, 'src/auth/session.ts', 'three unread auth lines beat forty unread doc lines');
    assert.equal(first.severe, true);
    assert.equal(first.line, 1, 'a click lands on the first unread line');
    assert.equal(first.children.length, 1);
    assert.equal(first.children[0].label, 'lines 1–3');
    assert.match(first.children[0].description, /3 unread · authentication/);
    assert.match(first.description, /3 unread · 25% · critical/);
  });

  test('reading mode leads with progress, not with what is missing', () => {
    const r = report(
      { 'src/app.ts': { lines: ['a', 'b', 'c', 'd'], changed: [1, 2, 3, 4], read: [1, 2, 3] } },
      { mode: 'reading', baseRef: 'workspace' },
    );
    const summary = buildTree(r)[0] as SummaryNode;
    assert.equal(summary.label, '75% read');
    assert.match(summary.description, /3 of 4 lines · files you have opened/);
  });

  test('a fully read file keeps its place but has nothing to expand', () => {
    const r = report({ 'src/app.ts': { lines: ['a'], changed: [1], read: [1] } });
    const file = buildTree(r)[1] as FileNode;
    assert.equal(file.unseenLines, 0);
    assert.deepEqual(file.children, []);
    assert.equal(file.severe, false);
    assert.equal(file.description, '100%');
  });

  test('nothing to measure is said plainly, in the words of the mode', () => {
    const empty: ReportSources = { getText: () => undefined, getEvidence: () => undefined };
    const diff = buildTree(buildReport([], empty, cfg, 'HEAD', 0));
    assert.equal(diff[0].kind, 'notice');
    assert.equal(diff[0].label, 'No changes');
    const reading = buildTree(buildReport([], empty, cfg, 'workspace', 0, { mode: 'reading' }));
    assert.equal(reading[0].label, 'No files opened yet');
    assert.equal(buildTree(null)[0].kind, 'notice');
  });
});

describe('labels', () => {
  test('the base is named for what it is', () => {
    assert.equal(baseLabel({ mode: 'diff', baseRef: 'HEAD', sinceReview: false }), 'since HEAD');
    assert.equal(
      baseLabel({ mode: 'diff', baseRef: '0123456789abcdef0123456789abcdef01234567', sinceReview: true }),
      'since review 0123456',
    );
    assert.equal(baseLabel({ mode: 'reading', baseRef: 'workspace', sinceReview: false }), 'files you have opened');
    assert.equal(shortRef('main'), 'main');
  });

  test('the headline points the opposite way in the two modes', () => {
    assert.deepEqual(headline({ mode: 'diff', coverage: 0.64, blindspot: 0.36 }), { value: 36, label: 'unread' });
    assert.deepEqual(headline({ mode: 'reading', coverage: 0.64, blindspot: 0.36 }), { value: 64, label: 'read' });
  });

  test('pace is flagged only past the point where reviewers stop finding defects', () => {
    assert.equal(paceIsFast({ attentionMs: 60_000, linesPerMinute: 6 }), false);
    assert.equal(paceIsFast({ attentionMs: 60_000, linesPerMinute: 30 }), true);
    assert.equal(paceIsFast({ attentionMs: 0, linesPerMinute: null }), false);
    assert.equal(paceLabel({ attentionMs: 60_000, linesPerMinute: 12.5 }), '≈ 12.5 lines/min');
  });
});
