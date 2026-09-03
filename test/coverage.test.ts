import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { buildReport, isIgnored, pageData, wholeFileTarget, type ReportSources } from '../src/core/coverage';
import { emptyActivity, emptyEvidence, type FileDiff, type LineEvidence } from '../src/core/types';

const cfg = DEFAULT_CONFIG;

/** Evidence that clears the review threshold. */
function read(): LineEvidence {
  return { ...emptyEvidence(), visibleMs: 2000, focusedMs: 2000, dwellEvents: 1, caretHits: 1 };
}

/** Evidence from scrolling past without stopping. */
function skimmed(): LineEvidence {
  return { ...emptyEvidence(), visibleMs: 400, focusedMs: 100 };
}

function machine(reviewed: boolean): LineEvidence {
  return { ...(reviewed ? read() : skimmed()), provenance: 'bulk' };
}

interface Fixture {
  diffs: FileDiff[];
  sources: ReportSources;
}

function fixture(files: Record<string, { lines: string[]; changed: number[]; evidence?: Record<number, LineEvidence> }>): Fixture {
  const diffs: FileDiff[] = Object.entries(files).map(([file, f]) => ({
    file,
    addedLines: f.changed,
    modifiedLines: [],
    deletedLines: 0,
    binary: false,
  }));
  const sources: ReportSources = {
    getText: (file) => files[file]?.lines,
    getEvidence: (file, line) => files[file]?.evidence?.[line],
  };
  return { diffs, sources };
}

describe('buildReport', () => {
  test('counts reviewed and unseen lines', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': {
        lines: ['a', 'b', 'c', 'd'],
        changed: [1, 2, 3, 4],
        evidence: { 1: read(), 2: read(), 3: skimmed() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');

    assert.equal(r.totalChangedLines, 4);
    assert.equal(r.reviewedLines, 2);
    assert.equal(r.unseenLines, 2);
    assert.equal(r.coverage, 0.5);
    assert.equal(r.blindspot, 0.5);
  });

  test('a line with no evidence at all is unseen, not missing', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': { lines: ['a', 'b'], changed: [1, 2] },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    assert.equal(r.unseenLines, 2);
    assert.equal(r.coverage, 0);
  });

  test('groups adjacent unread lines into one hunk', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': {
        lines: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`),
        changed: [3, 4, 5, 12, 13],
        evidence: {},
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    assert.equal(r.hunks.length, 2);
    const [first, second] = [...r.hunks].sort((a, b) => a.startLine - b.startLine);
    assert.deepEqual([first.startLine, first.endLine, first.lineCount], [3, 5, 3]);
    assert.deepEqual([second.startLine, second.endLine, second.lineCount], [12, 13, 2]);
  });

  test('a small reviewed gap does not split a hunk in two', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': {
        lines: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`),
        changed: [3, 4, 6, 7],
        evidence: { 5: read() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    assert.equal(r.hunks.length, 1);
    assert.equal(r.hunks[0].startLine, 3);
    assert.equal(r.hunks[0].endLine, 7);
  });

  test('ranks the dangerous blindspot above the large one', () => {
    const { diffs, sources } = fixture({
      'README.md': {
        lines: Array.from({ length: 60 }, () => 'docs'),
        changed: Array.from({ length: 40 }, (_, i) => i + 1),
      },
      'src/auth/session.ts': {
        lines: ['const token = sign(payload)', 'return token', 'export {}'],
        changed: [1, 2, 3],
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');

    assert.equal(r.worstFile?.file, 'src/auth/session.ts', '3 unread auth lines beat 40 unread doc lines');
    assert.equal(r.hunks[0].file, 'src/auth/session.ts');
    assert.equal(r.hunks[0].risk, 'critical');
  });

  test('a file whose only unread lines are harmless does not rank as critical', () => {
    const { diffs, sources } = fixture({
      'src/auth/session.ts': {
        lines: ['const token = sign(payload)', '// helper below', 'return token'],
        changed: [1, 2, 3],
        evidence: { 1: read(), 3: read() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    assert.equal(r.files[0].risk, 'critical', 'the diff did touch critical code');
    assert.equal(r.files[0].blindspotRisk, 'high', 'but the unread line is only a comment');
  });

  test('weighted coverage punishes unread risky lines harder', () => {
    const { diffs, sources } = fixture({
      'src/auth/token.ts': {
        lines: ['// comment', 'const secret = process.env.KEY'],
        changed: [1, 2],
        evidence: { 1: read() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    const file = r.files[0];
    assert.equal(file.coverage, 0.5);
    assert.ok(file.weightedCoverage < 0.5, 'the unread line is the expensive one');
  });

  test('tracks the AI bucket separately from everything else', () => {
    const { diffs, sources } = fixture({
      'src/gen.ts': {
        lines: ['a', 'b', 'c', 'd'],
        changed: [1, 2, 3, 4],
        evidence: { 1: machine(true), 2: machine(false), 3: read(), 4: read() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');

    assert.equal(r.files[0].aiLines, 2);
    assert.equal(r.files[0].aiReviewedLines, 1);
    assert.equal(r.score.measured.ai, true);
    assert.equal(r.score.ai, 0.5);
    assert.equal(r.coverage, 0.75, 'human lines are measured too');
  });

  test('reports the machine-written share of a hunk', () => {
    const { diffs, sources } = fixture({
      'src/gen.ts': {
        lines: ['a', 'b', 'c', 'd'],
        changed: [1, 2],
        evidence: { 1: machine(false), 2: skimmed() },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD');
    assert.equal(r.hunks[0].aiRatio, 0.5);
  });

  test('skips binary and ignored files', () => {
    const diffs: FileDiff[] = [
      { file: 'logo.png', addedLines: [], modifiedLines: [], deletedLines: 0, binary: true },
      { file: 'node_modules/x/index.js', addedLines: [1, 2], modifiedLines: [], deletedLines: 0, binary: false },
      { file: 'src/a.ts', addedLines: [1], modifiedLines: [], deletedLines: 0, binary: false },
    ];
    const sources: ReportSources = { getText: () => ['x'], getEvidence: () => undefined };
    const r = buildReport(diffs, sources, cfg, 'HEAD');

    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].file, 'src/a.ts');
  });

  test('an empty diff is fully covered, not zero covered', () => {
    const r = buildReport([], { getText: () => undefined, getEvidence: () => undefined }, cfg, 'HEAD');
    assert.equal(r.totalChangedLines, 0);
    assert.equal(r.coverage, 1);
    assert.equal(r.worstFile, null);
    assert.equal(r.hunks.length, 0);
  });

  test('works when the file text is unavailable', () => {
    // A file deleted between the diff and the read still has changed lines.
    const diffs: FileDiff[] = [
      { file: 'src/gone.ts', addedLines: [1, 2], modifiedLines: [], deletedLines: 0, binary: false },
    ];
    const r = buildReport(diffs, { getText: () => undefined, getEvidence: () => undefined }, cfg, 'HEAD');
    assert.equal(r.totalChangedLines, 2);
    assert.equal(r.unseenLines, 2);
  });
});

describe('metrics', () => {
  test('read, focus and activity are reported apart, and the composite is derived', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': {
        lines: ['a', 'b', 'c', 'd'],
        changed: [1, 2, 3, 4],
        // Two lines fully read, one half-way there, one never seen.
        evidence: {
          1: read(),
          2: read(),
          3: { ...emptyEvidence(), visibleMs: 350, focusedMs: 350 },
        },
      },
    });
    const r = buildReport(diffs, sources, cfg, 'HEAD', 0, {
      mode: 'reading',
      activity: { ...emptyActivity(), jumps: 1 },
    });
    const m = r.metrics;
    assert.equal(r.mode, 'reading');
    // Each of the 4 lines is worth 25 points; 'c' costs 0.25 × 2000 ms = 500 ms
    // to read and got 350 ms of it.
    assert.equal(m.read.score, 67.5);
    assert.equal(m.read.reviewedLines, 2);
    assert.equal(m.read.targetLines, 4);
    // Focus keeps growing past the read time; nothing here reached the cap.
    assert.equal(m.focus.fraction < m.read.fraction, true);
    assert.equal(m.focus.effectiveMs, 4350);
    // One jump for four lines is plenty of activity.
    assert.equal(m.activity.score, 100);
    assert.deepEqual(m.activity.counts.jumps, 1);
    const w = cfg.finalWeights;
    const expected = Math.round((w.read * m.read.fraction + w.focus * m.focus.fraction + w.activity * 1) * 1000) / 10;
    assert.equal(m.final, expected);
  });

  test('an empty target reads as complete and unfocused, not as NaN', () => {
    const r = buildReport([], { getText: () => undefined, getEvidence: () => undefined }, cfg, 'HEAD');
    assert.equal(r.metrics.read.score, 100);
    assert.equal(r.metrics.focus.score, 0);
    assert.equal(r.metrics.activity.score, 0);
    assert.equal(Number.isFinite(r.metrics.final), true);
  });

  test('a whole file is a target of every line, without the phantom last one', () => {
    const t = wholeFileTarget('src/app.ts', ['a', 'b', 'c', '']);
    assert.deepEqual(t.addedLines, [1, 2, 3]);
    assert.deepEqual(t.modifiedLines, []);
    assert.deepEqual(wholeFileTarget('empty.ts', []).addedLines, []);
  });
});

describe('isIgnored', () => {
  test('matches directory globs at any depth', () => {
    assert.equal(isIgnored('node_modules/x/y.js', ['**/node_modules/**']), true);
    assert.equal(isIgnored('a/b/node_modules/x.js', ['**/node_modules/**']), true);
    assert.equal(isIgnored('src/app.ts', ['**/node_modules/**']), false);
  });

  test('matches extension globs', () => {
    assert.equal(isIgnored('yarn.lock', ['**/*.lock']), true);
    assert.equal(isIgnored('deep/dir/yarn.lock', ['**/*.lock']), true);
    assert.equal(isIgnored('src/lock.ts', ['**/*.lock']), false);
  });

  test('a single star does not cross directory boundaries', () => {
    assert.equal(isIgnored('src/a.ts', ['src/*.ts']), true);
    assert.equal(isIgnored('src/nested/a.ts', ['src/*.ts']), false);
  });
});

describe('pageData', () => {
  /** The page's own rule, as written in media/page.html. */
  function judgedByPage(page: ReturnType<typeof pageData>): number {
    const w = page.weights;
    let n = 0;
    for (const f of page.files) {
      for (const l of f.lines) {
        const s = l.signals;
        const points =
          (s.visible ? w.visible : 0) +
          (s.focused ? w.focused : 0) +
          (s.dwell ? w.dwell : 0) +
          (s.caret ? w.caret : 0) +
          (s.edited ? w.edited : 0) +
          (s.revisit ? w.revisit : 0);
        if (points >= page.threshold && (s.edited || l.read >= 1)) n += 1;
      }
    }
    return n;
  }

  test('one row per target line, judged the way the report judges it', () => {
    const typed: LineEvidence = { ...emptyEvidence('typed'), humanEdits: 1, visibleMs: 500, focusedMs: 900, caretHits: 1 };
    const { diffs, sources } = fixture({
      'src/app.ts': {
        lines: ['a', 'b', 'c', 'd'],
        changed: [1, 2, 4],
        evidence: { 1: read(), 2: skimmed(), 4: typed },
      },
    });
    const page = pageData(diffs, sources, cfg);
    const r = buildReport(diffs, sources, cfg, 'HEAD');

    assert.equal(page.threshold, cfg.reviewThresholdPoints);
    assert.deepEqual(page.weights, cfg.weights);
    assert.deepEqual(page.files.map((f) => f.path), ['src/app.ts']);
    assert.deepEqual(page.files[0].lines.map((l) => l.n), [1, 2, 4]);
    assert.deepEqual(page.files[0].lines.map((l) => l.text), ['a', 'b', 'd']);
    assert.equal(judgedByPage(page), r.reviewedLines);
    assert.equal(r.reviewedLines, 2, 'the fixture exercises both ways to be reviewed');
  });

  test('carries risk and authorship per line', () => {
    const { diffs, sources } = fixture({
      'src/auth/session.ts': { lines: ['const a = 1;'], changed: [1], evidence: { 1: machine(false) } },
    });
    const line = pageData(diffs, sources, cfg).files[0].lines[0];
    assert.equal(line.risk, 'critical');
    assert.equal(typeof line.reason, 'string');
    assert.equal(line.ai, true);
  });

  test('skips binary and ignored files, like the report', () => {
    const { diffs, sources } = fixture({
      'src/app.ts': { lines: ['a'], changed: [1] },
      'yarn.lock': { lines: ['x'], changed: [1] },
      'img.png': { lines: [], changed: [] },
    });
    diffs[2].binary = true;
    const page = pageData(diffs, sources, { ...cfg, ignore: ['**/*.lock'] });
    assert.deepEqual(page.files.map((f) => f.path), ['src/app.ts']);
  });
});
