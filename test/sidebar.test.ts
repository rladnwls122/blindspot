import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { DiffReport, FileReport } from '../src/core/types';
import { buildTree } from '../src/core/tree';

/**
 * The sidebar tree is built by a pure function so it can be tested without a
 * `vscode` stub: reports in, groups out. What matters is that the two numbers
 * carry their direction in words — "36% unread" is a warning, "38% read" is
 * progress — and that the diff group always comes first.
 */

function file(overrides: Partial<FileReport> = {}): FileReport {
  return {
    file: 'src/a.ts',
    changedLines: 10,
    reviewedLines: 4,
    unseenLines: 6,
    coverage: 0.4,
    weightedCoverage: 0.4,
    risk: 'medium',
    blindspotRisk: 'medium',
    aiLines: 0,
    aiReviewedLines: 0,
    hunks: [
      { file: 'src/a.ts', startLine: 12, endLine: 14, lineCount: 3, risk: 'medium', reason: '', aiRatio: 0 },
      { file: 'src/a.ts', startLine: 3, endLine: 5, lineCount: 3, risk: 'low', reason: '', aiRatio: 0 },
    ],
    ...overrides,
  };
}

function report(files: FileReport[], overrides: Partial<DiffReport> = {}): DiffReport {
  const total = files.reduce((n, f) => n + f.changedLines, 0);
  const reviewed = files.reduce((n, f) => n + f.reviewedLines, 0);
  return {
    baseRef: 'HEAD',
    generatedAt: 0,
    totalChangedLines: total,
    reviewedLines: reviewed,
    unseenLines: total - reviewed,
    coverage: total ? reviewed / total : 1,
    blindspot: total ? 1 - reviewed / total : 0,
    score: {
      coverage: 0,
      critical: 0,
      newCode: 0,
      ai: 0,
      score: 0,
      measured: { coverage: true, critical: false, newCode: false, ai: false },
    },
    files,
    hunks: files.flatMap((f) => f.hunks),
    worstFile: files[0] ?? null,
    ...overrides,
  };
}

describe('sidebar tree', () => {
  test('no report, or an empty diff, produces no groups', () => {
    assert.deepEqual(buildTree(null), []);
    assert.deepEqual(buildTree(report([])), []);
  });

  test('the diff group says how much is unread, per file', () => {
    const [diff] = buildTree(report([file()]));
    assert.equal(diff.label, 'Diff');
    assert.equal(diff.description, '60% unread');
    assert.equal(diff.children.length, 1);
    const [a] = diff.children;
    assert.equal(a.label, 'src/a.ts');
    assert.equal(a.description, '40%  6 unread');
    assert.equal(a.file, 'src/a.ts');
  });

  test('a click lands on the first unread line, not the worst-ranked hunk', () => {
    const [diff] = buildTree(report([file()]));
    assert.equal(diff.children[0].firstUnreadLine, 3);
  });

  test('a fully reviewed file has nowhere to jump to', () => {
    const done = file({ reviewedLines: 10, unseenLines: 0, coverage: 1, hunks: [] });
    const [diff] = buildTree(report([done]));
    assert.equal(diff.children[0].description, '100%');
    assert.equal(diff.children[0].firstUnreadLine, null);
    assert.equal(diff.children[0].severe, false);
  });

  test('unread high-risk code earns the warning, read high-risk code does not', () => {
    const unread = file({ blindspotRisk: 'critical' });
    const read = file({ file: 'src/b.ts', risk: 'critical', blindspotRisk: 'low' });
    const [diff] = buildTree(report([unread, read]));
    assert.equal(diff.children[0].severe, true);
    assert.equal(diff.children[1].severe, false);
    assert.match(diff.children[0].tooltip, /high-risk/);
  });

  test('a scope report becomes a second group that reads the other way round', () => {
    const groups = buildTree(report([file()]), report([file({ file: 'vendor/lib.ts' })]));
    assert.deepEqual(
      groups.map((g) => [g.label, g.description]),
      [
        ['Diff', '60% unread'],
        ['Tracked', '40% read'],
      ],
    );
    // Ids are unique across groups so a file in both never collapses into one row.
    assert.notEqual(groups[0].children[0].id, groups[1].children[0].id);
  });

  test('with no changes, only the tracked group is shown', () => {
    const groups = buildTree(report([]), report([file()]));
    assert.deepEqual(
      groups.map((g) => g.label),
      ['Tracked'],
    );
  });
});
