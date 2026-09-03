import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { buildReport, type ReportSources } from '../src/core/coverage';
import {
  renderBlindspots,
  renderCard,
  renderFiles,
  renderReading,
  renderScore,
  renderSummaryLine,
  renderTrailer,
  visualWidth,
} from '../src/core/render';
import { emptyEvidence, type FileDiff, type LineEvidence } from '../src/core/types';

const cfg = DEFAULT_CONFIG;

function read(): LineEvidence {
  return { ...emptyEvidence(), visibleMs: 2000, focusedMs: 2000, dwellEvents: 1, caretHits: 1 };
}

function report(files: Record<string, { lines: string[]; changed: number[]; read?: number[] }>) {
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
  return buildReport(diffs, sources, cfg, 'HEAD', 0);
}

describe('renderCard', () => {
  const r = report({
    'src/app.ts': { lines: ['a', 'b', 'c', 'd'], changed: [1, 2, 3, 4], read: [1, 2, 3] },
  });

  test('leads with coverage and its complement', () => {
    const card = renderCard(r);
    assert.match(card, /Review coverage\s+75%/);
    assert.match(card, /Blindspot\s+25%/);
  });

  test('shows the three counts', () => {
    const card = renderCard(r);
    assert.match(card, /4 changed lines/);
    assert.match(card, /3 reviewed/);
    assert.match(card, /1 unseen/);
  });

  test('every row is the same width', () => {
    const rows = renderCard(r).split('\n');
    const widths = new Set(rows.map(visualWidth));
    assert.equal(widths.size, 1, `ragged card: ${[...widths].join(', ')}`);
  });

  test('stays aligned when a long path has to be truncated', () => {
    const long = report({
      'src/auth/deeply/nested/directory/session-management-helper.ts': {
        lines: ['const token = sign(x)'],
        changed: [1],
      },
    });
    const widths = new Set(renderCard(long).split('\n').map(visualWidth));
    assert.equal(widths.size, 1);
  });

  test('surfaces the worst hunk when high-risk code is unread', () => {
    const risky = report({
      'src/auth/session.ts': { lines: ['const token = sign(x)', 'return token'], changed: [1, 2] },
    });
    const card = renderCard(risky);
    assert.match(card, /CRITICAL/);
    assert.match(card, /session\.ts/);
    assert.match(card, /lines 1-2 unread/);
  });

  test('says nothing about risk when everything has been read', () => {
    const clean = report({
      'src/auth/session.ts': { lines: ['const token = sign(x)'], changed: [1], read: [1] },
    });
    const card = renderCard(clean);
    assert.equal(/CRITICAL/.test(card), false);
    assert.match(card, /Blindspot\s+0%/);
  });
});

describe('renderFiles', () => {
  test('rates the blindspot, not the diff', () => {
    // The file touches critical code, but the only unread line is a comment.
    const r = report({
      'src/auth/session.ts': {
        lines: ['const token = sign(payload)', '// helper below', 'return token'],
        changed: [1, 2, 3],
        read: [1, 3],
      },
    });
    const table = renderFiles(r);
    assert.match(table, /HIGH RISK/);
    assert.equal(/CRITICAL/.test(table), false);
  });

  test('a fully reviewed file has no blindspot left to rate', () => {
    const r = report({
      'src/auth/session.ts': { lines: ['const token = sign(x)'], changed: [1], read: [1] },
    });
    const row = renderFiles(r).split('\n').find((l) => l.includes('session.ts'));
    assert.ok(row);
    assert.match(row, /—\s*$/);
    assert.equal(/CRITICAL/.test(row), false);
  });

  test('handles a diff with no files', () => {
    const empty = buildReport([], { getText: () => undefined, getEvidence: () => undefined }, cfg, 'HEAD', 0);
    assert.match(renderFiles(empty), /No changed files/);
  });
});

describe('renderBlindspots', () => {
  test('says so plainly when there is nothing left', () => {
    const r = report({ 'a.ts': { lines: ['x'], changed: [1], read: [1] } });
    assert.match(renderBlindspots(r), /No blindspots/);
  });

  test('lists unread ranges with their reason', () => {
    const r = report({
      'src/auth/session.ts': { lines: ['const token = sign(x)', 'return token'], changed: [1, 2] },
    });
    const text = renderBlindspots(r);
    assert.match(text, /lines 1–2/);
    assert.match(text, /2 unread/);
    assert.match(text, /authentication/);
  });

  test('truncates a long list and says how many are left', () => {
    const files: Record<string, { lines: string[]; changed: number[] }> = {};
    for (let i = 0; i < 20; i++) {
      files[`src/file${i}.ts`] = { lines: ['a'], changed: [1] };
    }
    assert.match(renderBlindspots(report(files), 5), /and 15 more/);
  });
});

describe('renderScore', () => {
  test('shows the composite and each component', () => {
    const r = report({
      'src/auth/session.ts': { lines: ['const token = sign(x)', 'return token'], changed: [1, 2], read: [1] },
    });
    const text = renderScore(r);
    assert.match(text, /Review Score/);
    assert.match(text, /Coverage\s+50%/);
    assert.match(text, /Critical\s+50%/);
  });

  test('unmeasured components print a dash, not a zero', () => {
    const r = report({ 'notes.md': { lines: ['hello'], changed: [1] } });
    const text = renderScore(r);
    // Nothing in this diff was machine-written.
    assert.match(text, /AI-generated\s+—/);
  });
});

describe('renderTrailer', () => {
  test('is one git-trailer-shaped line', () => {
    const r = report({
      'src/app.ts': { lines: ['a', 'b', 'c', 'd'], changed: [1, 2, 3, 4], read: [1, 2, 3] },
    });
    assert.equal(renderTrailer(r), 'Blindspot: 25% (1/4 lines unread)');
  });

  test('a fully read diff still gets one — 0% is a data point', () => {
    const r = report({ 'src/app.ts': { lines: ['a', 'b'], changed: [1, 2], read: [1, 2] } });
    assert.equal(renderTrailer(r), 'Blindspot: 0% (0/2 lines unread)');
  });

  test('nothing to measure means no trailer, not a trailer about nothing', () => {
    assert.equal(renderTrailer(report({})), null);
  });
});

describe('renderReading', () => {
  test('shows the three measurements apart, the pace, and what was interacted with', () => {
    const r = report({
      'src/app.ts': { lines: ['a', 'b', 'c', 'd'], changed: [1, 2, 3, 4], read: [1, 2] },
    });
    const text = renderReading(r);
    assert.match(text, /Read\s+\d+(\.\d+)?\s+2\/4 lines, 2 interacted with/);
    assert.match(text, /Focus\s+\d+/);
    assert.match(text, /Activity\s+\d+/);
    assert.match(text, /Pace\s+≈ \d+(\.\d+)? lines\/min/);
    assert.match(text, /Final \d+/);
  });

  test('says when deletions went unmeasured', () => {
    const diffs = [{ file: 'a.ts', addedLines: [1], modifiedLines: [], deletedLines: 3, binary: false }];
    const r = buildReport(diffs, { getText: () => ['x'], getEvidence: () => undefined }, cfg, 'HEAD', 0);
    assert.match(renderReading(r), /3 lines removed, not measured/);
    assert.match(renderReading(r), /no reading time yet/);
  });
});

describe('renderSummaryLine', () => {
  test('describes the blindspot, not the coverage', () => {
    const r = report({ 'a.ts': { lines: ['x', 'y', 'z', 'w'], changed: [1, 2, 3, 4], read: [1] } });
    assert.equal(renderSummaryLine(r), 'Blindspot 75% · 3/4 lines unread');
  });

  test('handles an empty diff', () => {
    const empty = buildReport([], { getText: () => undefined, getEvidence: () => undefined }, cfg, 'HEAD', 0);
    assert.match(renderSummaryLine(empty), /no changes/);
  });
});

describe('visualWidth', () => {
  test('counts CJK as two columns so boxes stay square', () => {
    assert.equal(visualWidth('abc'), 3);
    assert.equal(visualWidth('한글'), 4);
    assert.equal(visualWidth('a한b'), 4);
  });

  test('ignores zero-width joiners and variation selectors', () => {
    assert.equal(visualWidth('⚠️'), 1);
  });
});
