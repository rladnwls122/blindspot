import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LineLedger, hasEvidence } from '../src/core/ledger';
import { hashLine } from '../src/core/hash';

const NOW = 1_700_000_000_000;

function readLedger(text: string[]): LineLedger {
  const l = new LineLedger();
  l.resize(text.length);
  return l;
}

describe('LineLedger crediting', () => {
  test('credits a visible range and only that range', () => {
    const l = readLedger(['a', 'b', 'c', 'd']);
    l.addVisible(2, 3, 500, true, NOW);
    assert.equal(l.at(1).visibleMs, 0);
    assert.equal(l.at(2).visibleMs, 500);
    assert.equal(l.at(3).focusedMs, 500);
    assert.equal(l.at(4).visibleMs, 0);
  });

  test('unfocused time counts as visible but not focused', () => {
    const l = readLedger(['a']);
    l.addVisible(1, 1, 800, false, NOW);
    assert.equal(l.at(1).visibleMs, 800);
    assert.equal(l.at(1).focusedMs, 0);
  });
});

describe('LineLedger.applyChange', () => {
  test('inserting above shifts evidence down with the line', () => {
    const l = readLedger(['import a', 'const x = 1', 'export default x']);
    l.addVisible(2, 2, 2000, true, NOW);
    l.addDwell(2, 2, NOW);

    // Insert one line at the top: `const x = 1` moves from line 2 to line 3.
    l.applyChange(1, 1, 2, { human: true, provenance: 'typed', now: NOW });

    assert.equal(l.at(3).visibleMs, 2000, 'evidence followed the line down');
    assert.equal(l.at(3).dwellEvents, 1);
  });

  test('rewriting a line discards the eye-time spent on its old content', () => {
    const l = readLedger(['const timeout = 30']);
    l.addVisible(1, 1, 5000, true, NOW);
    l.addDwell(1, 1, NOW);
    assert.equal(l.at(1).visibleMs, 5000);

    l.applyChange(1, 1, 1, { human: true, provenance: 'typed', now: NOW });

    assert.equal(l.at(1).visibleMs, 0, 'old reading time does not vouch for new text');
    assert.equal(l.at(1).dwellEvents, 0);
    assert.equal(l.at(1).humanEdits, 1, 'but the edit itself is evidence');
  });

  test('a machine paste is recorded as bulk and earns no human-edit credit', () => {
    const l = readLedger(['// here']);
    l.applyChange(1, 1, 12, { human: false, provenance: 'bulk', now: NOW });

    assert.equal(l.length, 12);
    for (let i = 1; i <= 12; i++) {
      assert.equal(l.at(i).provenance, 'bulk');
      assert.equal(l.at(i).humanEdits, 0, `line ${i} was not written by a human`);
    }
  });

  test('deleting lines removes their evidence rather than shifting it up', () => {
    const l = readLedger(['a', 'b', 'c', 'd']);
    l.addVisible(3, 3, 4000, true, NOW);
    l.addCaret(3, 3, NOW);

    // Replace lines 1-3 with a single line.
    l.applyChange(1, 3, 1, { human: true, provenance: 'typed', now: NOW });

    assert.equal(l.length, 2);
    assert.equal(l.at(1).visibleMs, 0, 'deleted evidence did not leak onto the survivor');
    assert.equal(l.at(2).visibleMs, 0);
  });

  test('changes applied bottom-up leave upper evidence intact', () => {
    const l = readLedger(['a', 'b', 'c', 'd', 'e']);
    l.addVisible(1, 1, 1000, true, NOW);
    l.applyChange(4, 4, 3, { human: false, provenance: 'bulk', now: NOW });
    assert.equal(l.at(1).visibleMs, 1000);
    assert.equal(l.length, 7);
  });
});

describe('LineLedger.anchor', () => {
  const text = ['import a', 'const x = 1', 'function go() {', '  return x', '}'];

  function stored(l: LineLedger, t: string[]) {
    return l.serialize(t);
  }

  test('re-attaches evidence to the same content after an insertion above', () => {
    const l = readLedger(text);
    l.addVisible(4, 4, 3000, true, NOW);
    l.addDwell(4, 4, NOW);
    const saved = stored(l, text);

    const laterText = ['// new header', '', ...text];
    const restored = LineLedger.anchor(saved, laterText);

    assert.equal(restored.at(6).visibleMs, 3000, '`  return x` kept its evidence at its new line');
    assert.equal(restored.at(1).visibleMs, 0);
  });

  test('re-indenting a line does not erase that you read it', () => {
    const l = readLedger(text);
    l.addVisible(4, 4, 3000, true, NOW);
    const saved = stored(l, text);

    const reindented = [...text];
    reindented[3] = '\t\treturn x';
    const restored = LineLedger.anchor(saved, reindented);

    assert.equal(restored.at(4).visibleMs, 3000);
  });

  test('changing a line does erase that you read it', () => {
    const l = readLedger(text);
    l.addVisible(4, 4, 3000, true, NOW);
    const saved = stored(l, text);

    const changed = [...text];
    changed[3] = '  return x + 1';
    const restored = LineLedger.anchor(saved, changed);

    assert.equal(restored.at(4).visibleMs, 0, 'new content must be read again');
  });

  test('a moved block keeps its evidence', () => {
    const l = readLedger(text);
    l.addVisible(3, 5, 2500, true, NOW);
    const saved = stored(l, text);

    const moved = ['function go() {', '  return x', '}', 'import a', 'const x = 1'];
    const restored = LineLedger.anchor(saved, moved);

    assert.equal(restored.at(1).visibleMs, 2500, 'moving code you read does not make it unread');
    assert.equal(restored.at(2).visibleMs, 2500);
  });

  test('duplicate lines are matched in order, not all to the first match', () => {
    const dupText = ['}', 'x', '}', 'y', '}'];
    const l = readLedger(dupText);
    l.addVisible(3, 3, 1234, true, NOW);
    const saved = l.serialize(dupText);

    const restored = LineLedger.anchor(saved, dupText);
    assert.equal(restored.at(1).visibleMs, 0);
    assert.equal(restored.at(3).visibleMs, 1234);
    assert.equal(restored.at(5).visibleMs, 0);
  });

  test('unknown lines start with no evidence', () => {
    const restored = LineLedger.anchor([], ['brand', 'new', 'file']);
    assert.equal(restored.length, 3);
    for (let i = 1; i <= 3; i++) assert.equal(hasEvidence(restored.peek(i)), false);
  });

  test('serialize skips lines with nothing to say', () => {
    const l = readLedger(text);
    l.addCaret(2, 2, NOW);
    const saved = l.serialize(text);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].h, hashLine('const x = 1'));
  });
});

describe('LineLedger.resize', () => {
  test('grows and truncates to match the document', () => {
    const l = new LineLedger();
    l.resize(3);
    assert.equal(l.length, 3);
    l.addVisible(3, 3, 100, true, NOW);
    l.resize(1);
    assert.equal(l.length, 1);
  });
});

describe('LineLedger.mergeFrom', () => {
  test('folds a second view of the same document together', () => {
    const a = readLedger(['x', 'y']);
    const b = readLedger(['x', 'y']);
    a.addVisible(1, 1, 300, true, NOW);
    b.addVisible(1, 1, 700, false, NOW);
    b.addCaret(2, 2, NOW);

    a.mergeFrom(b);
    assert.equal(a.at(1).visibleMs, 1000);
    assert.equal(a.at(2).caretHits, 1);
  });
});
