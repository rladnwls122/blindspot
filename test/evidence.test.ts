import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { evaluate, explain, isMachineAuthored, mergeEvidence, strongerProvenance } from '../src/core/evidence';
import { emptyEvidence, type LineEvidence } from '../src/core/types';

const cfg = DEFAULT_CONFIG;

function ev(patch: Partial<LineEvidence>): LineEvidence {
  return { ...emptyEvidence(), ...patch };
}

/**
 * These three cases are the project's definition of "read", written as
 * assertions. If a future scoring model breaks one of them, it is a different
 * product, not a tuned one.
 */
describe('the definition of "read"', () => {
  test('scrolling over a line is not reviewing it', () => {
    // Long enough to register as on-screen, not long enough to have been read,
    // and the viewport never stopped.
    const s = evaluate(ev({ visibleMs: 400, focusedMs: 400 }), cfg);
    assert.equal(s.visible, true);
    assert.equal(s.dwell, false);
    assert.equal(s.reviewed, false);
  });

  test('visible for 0.2 seconds is not reviewing it', () => {
    const s = evaluate(ev({ visibleMs: 200, focusedMs: 200 }), cfg);
    assert.equal(s.visible, false);
    assert.equal(s.points, 0);
    assert.equal(s.reviewed, false);
  });

  test('visible plus a pause plus navigation counts as reviewed', () => {
    const s = evaluate(ev({ visibleMs: 1500, focusedMs: 1500, dwellEvents: 1, caretHits: 1 }), cfg);
    assert.equal(s.points >= cfg.reviewThresholdPoints, true);
    assert.equal(s.reviewed, true);
  });
});

describe('evaluate', () => {
  test('writing a line counts as reading it', () => {
    const s = evaluate(ev({ humanEdits: 1, visibleMs: 400, focusedMs: 100 }), cfg);
    assert.equal(s.edited, true);
    // edited (2) + visible (1) = 3
    assert.equal(s.points, 3);
    assert.equal(s.reviewed, true);
  });

  test('an edit alone is not enough under the default threshold', () => {
    const s = evaluate(ev({ humanEdits: 1 }), cfg);
    assert.equal(s.points, 2);
    assert.equal(s.reviewed, false);
  });

  test('a line nobody ever saw scores zero', () => {
    const s = evaluate(emptyEvidence(), cfg);
    assert.equal(s.points, 0);
    assert.equal(s.confidence, 0);
    assert.equal(s.reviewed, false);
  });

  test('confidence is bounded to [0,1]', () => {
    const s = evaluate(
      ev({ visibleMs: 1e9, focusedMs: 1e9, dwellEvents: 99, caretHits: 99, humanEdits: 99 }),
      cfg,
    );
    assert.equal(s.confidence, 1);
  });

  test('unfocused screen time never reaches the threshold on its own', () => {
    // A file left open in a background split for an hour.
    const s = evaluate(ev({ visibleMs: 3_600_000, focusedMs: 0 }), cfg);
    assert.equal(s.points, 1);
    assert.equal(s.reviewed, false);
  });

  test('the threshold is configurable without touching the evidence', () => {
    const strict = { ...cfg, reviewThresholdPoints: 5 };
    const evidence = ev({ visibleMs: 1500, focusedMs: 1500, dwellEvents: 1, caretHits: 1 });
    assert.equal(evaluate(evidence, cfg).reviewed, true);
    assert.equal(evaluate(evidence, strict).reviewed, false);
  });
});

describe('explain', () => {
  test('names every signal and the verdict', () => {
    const text = explain(ev({ visibleMs: 900, focusedMs: 900, dwellEvents: 1 }), cfg);
    assert.match(text, /reviewed|blindspot/);
    assert.match(text, /on screen/);
    assert.match(text, /paused/);
  });
});

describe('provenance', () => {
  test('a declared AI region outranks a bulk-insert guess', () => {
    assert.equal(strongerProvenance('bulk', 'declared-ai'), 'declared-ai');
    assert.equal(strongerProvenance('declared-ai', 'typed'), 'declared-ai');
    assert.equal(strongerProvenance('typed', 'unknown'), 'typed');
  });

  test('machine authorship covers bulk and declared, not typed', () => {
    assert.equal(isMachineAuthored('bulk'), true);
    assert.equal(isMachineAuthored('declared-ai'), true);
    assert.equal(isMachineAuthored('typed'), false);
    assert.equal(isMachineAuthored('unknown'), false);
  });

  test('merging sums time and keeps the strongest provenance', () => {
    const merged = mergeEvidence(
      ev({ visibleMs: 100, caretHits: 1, provenance: 'typed', lastSeen: 5 }),
      ev({ visibleMs: 250, dwellEvents: 2, provenance: 'bulk', lastSeen: 9 }),
    );
    assert.equal(merged.visibleMs, 350);
    assert.equal(merged.caretHits, 1);
    assert.equal(merged.dwellEvents, 2);
    assert.equal(merged.provenance, 'bulk');
    assert.equal(merged.lastSeen, 9);
  });
});
