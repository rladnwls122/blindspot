import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { focalWeight, focusLine, readCost } from '../src/core/attention';
import { LineLedger } from '../src/core/ledger';
import { evaluate } from '../src/core/evidence';

const cfg = DEFAULT_CONFIG;
const NOW = 1_700_000_000_000;

/**
 * The claim these tests defend: without an eye tracker, a viewport is not a
 * reading record. A tall editor showing 80 lines cannot have been read at the
 * same rate as the 10 lines around the caret, and a model that says otherwise
 * reports coverage that was never earned.
 */
describe('focal weighting', () => {
  test('the perceptual span around the focus gets full credit', () => {
    assert.equal(focalWeight(100, 100, cfg), 1);
    assert.equal(focalWeight(100 + cfg.focalSpanLines, 100, cfg), 1);
  });

  test('credit decays with distance and never reaches zero', () => {
    const near = focalWeight(110, 100, cfg);
    const far = focalWeight(140, 100, cfg);
    assert.equal(near > far, true);
    assert.equal(Math.abs(far - cfg.peripheralFloor) < 1e-9, true);
    assert.equal(far > 0, true);
  });

  test('it is symmetric — code above the caret is not privileged', () => {
    assert.equal(focalWeight(80, 100, cfg), focalWeight(120, 100, cfg));
  });

  test('turning the model off restores the flat viewport', () => {
    const flat = { ...cfg, focalModel: false };
    assert.equal(focalWeight(1, 500, flat), 1);
  });

  test('a tall viewport no longer reports its edges as read', () => {
    // 60 lines on screen, caret at the top, held still for 4 seconds.
    const focus = { line: 1, cfg };
    const ledger = new LineLedger();
    ledger.resize(60);
    for (let i = 0; i < 16; i++) ledger.addVisible(1, 60, 250, true, NOW + i * 250, focus);
    ledger.addDwell(1, 60, NOW + 4000, focus);

    assert.equal(evaluate(ledger.at(1), cfg).reviewed, true);
    assert.equal(evaluate(ledger.at(60), cfg).reviewed, false);
    // ...and the flat model would have called the bottom line read too.
    const flatLedger = new LineLedger();
    flatLedger.resize(60);
    for (let i = 0; i < 16; i++) flatLedger.addVisible(1, 60, 250, true, NOW + i * 250);
    flatLedger.addDwell(1, 60, NOW + 4000);
    assert.equal(evaluate(flatLedger.at(60), cfg).reviewed, true);
  });
});

describe('focus line', () => {
  test('the caret is the focus when it is on screen', () => {
    assert.equal(focusLine(42, 20, 60), 42);
  });

  test('the viewport centre is the fallback when the caret is scrolled away', () => {
    assert.equal(focusLine(5, 100, 140), 120);
  });
});

describe('read cost', () => {
  test('a blank line is cheap and a dense line is expensive', () => {
    assert.equal(readCost('', cfg), cfg.minReadCost);
    assert.equal(readCost('  }', cfg), cfg.minReadCost);
    assert.equal(readCost('const x = 1;', cfg) < 1, true);
    assert.equal(
      readCost('const totals = rows.reduce((acc, row) => acc + row.amount * row.qty, 0);', cfg) > 1,
      true,
    );
  });

  test('cost is clamped, so one pathological line cannot dominate', () => {
    const huge = 'a'.repeat(50).split('').join(' + ');
    assert.equal(readCost(huge, cfg) <= cfg.maxReadCost, true);
  });

  test('turning content scaling off restores one threshold for every line', () => {
    const flat = { ...cfg, contentScaling: false };
    assert.equal(readCost('}', flat), 1);
    assert.equal(readCost('a'.repeat(300), flat), 1);
  });
});

describe('re-reading', () => {
  test('returning after a gap is a new viewing episode', () => {
    const ledger = new LineLedger();
    ledger.resize(3);
    const focus = { line: 2, cfg };
    ledger.addVisible(1, 3, 1000, true, NOW, focus);
    assert.equal(ledger.at(2).revisits, 0);

    ledger.addVisible(1, 3, 1000, true, NOW + cfg.revisitGapMs + 1, focus);
    assert.equal(ledger.at(2).revisits, 1);
  });

  test('staying on the line is not re-reading it', () => {
    const ledger = new LineLedger();
    ledger.resize(3);
    const focus = { line: 2, cfg };
    for (let i = 0; i < 40; i++) ledger.addVisible(1, 3, 250, true, NOW + i * 250, focus);
    assert.equal(ledger.at(2).revisits, 0);
  });
});
