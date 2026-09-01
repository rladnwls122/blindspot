import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { bar, computeScore, pct, type ScoreBuckets } from '../src/core/score';

const cfg = DEFAULT_CONFIG;

function buckets(patch: Partial<ScoreBuckets>): ScoreBuckets {
  return {
    coverage: [0, 0],
    critical: [0, 0],
    newCode: [0, 0],
    ai: [0, 0],
    ...patch,
  };
}

describe('computeScore', () => {
  test('a fully reviewed diff scores 100', () => {
    const s = computeScore(
      buckets({ coverage: [50, 50], critical: [10, 10], newCode: [30, 30], ai: [20, 20] }),
      cfg,
    );
    assert.equal(s.score, 100);
  });

  test('an unreviewed diff scores 0', () => {
    const s = computeScore(buckets({ coverage: [0, 50], critical: [0, 10] }), cfg);
    assert.equal(s.score, 0);
  });

  test('components with nothing to measure are dropped, not scored as zero', () => {
    // No critical code and no AI code in this diff.
    const s = computeScore(buckets({ coverage: [40, 50], newCode: [40, 50] }), cfg);
    assert.equal(s.measured.critical, false);
    assert.equal(s.measured.ai, false);
    assert.equal(s.score, 80, 'the remaining weights renormalise to the measured components');
  });

  test('unread critical code drags the score below plain coverage', () => {
    const plain = computeScore(buckets({ coverage: [90, 100], critical: [10, 10] }), cfg);
    const risky = computeScore(buckets({ coverage: [90, 100], critical: [0, 10] }), cfg);
    assert.ok(risky.score < plain.score);
    assert.ok(risky.score < 90, 'a 90% diff with unread auth code is not a 90');
  });

  test('a diff made entirely of critical code is scored on that alone', () => {
    const s = computeScore(buckets({ coverage: [5, 10], critical: [5, 10] }), cfg);
    assert.equal(s.score, 50);
  });

  test('the AI component reflects only machine-written lines', () => {
    const s = computeScore(
      buckets({ coverage: [90, 100], critical: [10, 10], newCode: [90, 100], ai: [3, 10] }),
      cfg,
    );
    assert.equal(s.ai, 0.3);
    assert.ok(s.score < 90);
  });

  test('an empty diff does not divide by zero', () => {
    const s = computeScore(buckets({}), cfg);
    assert.equal(s.score, 0);
    assert.equal(s.coverage, 0);
    assert.equal(Number.isFinite(s.score), true);
  });
});

describe('bar', () => {
  test('renders ten cells', () => {
    assert.equal(bar(0).length, 10);
    assert.equal(bar(1), '██████████');
    assert.equal(bar(0), '░░░░░░░░░░');
    assert.equal(bar(0.82), '████████░░');
  });

  test('clamps out-of-range input', () => {
    assert.equal(bar(-5), '░░░░░░░░░░');
    assert.equal(bar(9), '██████████');
  });
});

describe('pct', () => {
  test('rounds to whole percentages and clamps', () => {
    assert.equal(pct(0.644), 64);
    assert.equal(pct(0.645), 65);
    assert.equal(pct(-1), 0);
    assert.equal(pct(2), 100);
  });
});
