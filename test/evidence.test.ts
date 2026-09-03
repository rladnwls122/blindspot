import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import {
  evaluate,
  explain,
  focusFraction,
  isMachineAuthored,
  mergeEvidence,
  readFraction,
  strongerProvenance,
} from '../src/core/evidence';
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
    const s = evaluate(ev({ visibleMs: 2500, focusedMs: 2500, dwellEvents: 1, caretHits: 1 }), cfg);
    assert.equal(s.points >= cfg.reviewThresholdPoints, true);
    assert.equal(s.reviewed, true);
  });

  test('enough signals but under the read time is still not read', () => {
    // Points say yes, the clock says no: a line that flashed past with the
    // caret on it was not read, however many signals it collected.
    const s = evaluate(ev({ visibleMs: 1500, focusedMs: 1500, dwellEvents: 1, caretHits: 1 }), cfg);
    assert.equal(s.points >= cfg.reviewThresholdPoints, true);
    assert.equal(s.reviewed, false);
    assert.equal(s.readFraction, 0.75);
  });

  test('read credit grows with focused time and stops at one', () => {
    assert.equal(readFraction(ev({}), cfg), 0);
    assert.equal(readFraction(ev({ focusedMs: 1000 }), cfg), 0.5);
    assert.equal(readFraction(ev({ focusedMs: 9000 }), cfg), 1);
    // Focus keeps growing past the read time, up to its own cap.
    assert.equal(focusFraction(ev({ focusedMs: 2000 }), cfg), 0.25);
    assert.equal(focusFraction(ev({ focusedMs: 9000 }), cfg), 1);
  });

  test('a dense line needs proportionally longer', () => {
    const dense = 'const token = jwt.sign({ sub: user.id, exp: now + ttl }, secret, { algorithm });';
    assert.equal(readFraction(ev({ focusedMs: 2000 }), cfg, dense) < 1, true);
    assert.equal(readFraction(ev({ focusedMs: 2000 }), cfg, '}') , 1);
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
      ev({ visibleMs: 1e9, focusedMs: 1e9, dwellEvents: 99, caretHits: 99, humanEdits: 99, revisits: 99 }),
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

  test('a re-read line only earns the revisit point on top of focused time', () => {
    // Scrolled past twice in a background split: two episodes, no focused time.
    const skimmed = evaluate(ev({ visibleMs: 900, focusedMs: 0, revisits: 3 }), cfg);
    assert.equal(skimmed.revisit, false);
    assert.equal(skimmed.reviewed, false);

    // Read, left, came back and read again.
    const reread = evaluate(ev({ visibleMs: 2000, focusedMs: 2000, revisits: 1 }), cfg);
    assert.equal(reread.revisit, true);
    assert.equal(reread.reviewed, true);
  });

  test('a dense line needs more time on screen than a closing brace', () => {
    const evidence = ev({ visibleMs: 400, focusedMs: 400 });
    assert.equal(evaluate(evidence, cfg, '}').visible, true);
    assert.equal(
      evaluate(evidence, cfg, 'const totals = rows.reduce((acc, row) => acc + row.amount * row.qty, 0);').visible,
      false,
    );
    // No text supplied: average cost, i.e. the historical flat behaviour.
    assert.equal(evaluate(evidence, cfg).visible, true);
  });

  test('the mouse resting on a line is navigation, as the caret is', () => {
    // Reading with the mouse leaves the caret at the top of the file. The
    // hover request the editor makes when the pointer stops is the same act
    // observed by a different sensor, and it satisfies the same signal.
    const byMouse = evaluate(ev({ visibleMs: 2500, focusedMs: 2500, dwellEvents: 1, pointerHits: 1 }), cfg);
    assert.equal(byMouse.caret, true);
    assert.equal(byMouse.interacted, true);
    assert.equal(byMouse.reviewed, true);
    // Screen time and a pause alone: read, but nobody touched it.
    const passive = evaluate(ev({ visibleMs: 2500, focusedMs: 2500, dwellEvents: 1 }), cfg);
    assert.equal(passive.reviewed, true);
    assert.equal(passive.interacted, false);
  });

  test('the threshold is configurable without touching the evidence', () => {
    const strict = { ...cfg, reviewThresholdPoints: 5 };
    const evidence = ev({ visibleMs: 2500, focusedMs: 2500, dwellEvents: 1, caretHits: 1 });
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

  test('says how the line was navigated to, by caret and by mouse', () => {
    const text = explain(ev({ caretHits: 1, pointerHits: 2 }), cfg);
    assert.match(text, /✓ navigated \(1× caret, 2× mouse\)/);
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
    assert.equal(merged.pointerHits, 0);
    assert.equal(merged.dwellEvents, 2);
    assert.equal(merged.provenance, 'bulk');
    assert.equal(merged.lastSeen, 9);
  });
});
