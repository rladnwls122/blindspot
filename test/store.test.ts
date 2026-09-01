import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState,
  parseAiRegions,
  parseState,
  pruneState,
  serializeState,
  STATE_VERSION,
} from '../src/core/store';
import { emptyEvidence } from '../src/core/types';

describe('parseState', () => {
  test('round-trips a saved state', () => {
    const state = emptyState();
    state.files['src/a.ts'] = [{ h: 'abc', i: 0, e: { ...emptyEvidence(), visibleMs: 1200, caretHits: 2 } }];
    state.trackedMs = 5000;

    const parsed = parseState(serializeState(state));
    assert.equal(parsed.files['src/a.ts'][0].e.visibleMs, 1200);
    assert.equal(parsed.files['src/a.ts'][0].e.caretHits, 2);
    assert.equal(parsed.trackedMs, 5000);
  });

  test('a truncated file degrades to no evidence rather than throwing', () => {
    const parsed = parseState('{"version":1,"files":{"a.ts":[{"h":"x","e":{"visib');
    assert.deepEqual(parsed.files, {});
  });

  test('a state from a future version is discarded', () => {
    const parsed = parseState(JSON.stringify({ version: STATE_VERSION + 1, files: { 'a.ts': [] } }));
    assert.deepEqual(parsed.files, {});
  });

  test('malformed entries are dropped individually', () => {
    const raw = JSON.stringify({
      version: STATE_VERSION,
      files: {
        'a.ts': [
          { h: 'good', e: { visibleMs: 10 } },
          { e: { visibleMs: 10 } },
          { h: 'nope' },
          'garbage',
          null,
        ],
      },
    });
    const parsed = parseState(raw);
    assert.equal(parsed.files['a.ts'].length, 1);
    assert.equal(parsed.files['a.ts'][0].h, 'good');
  });

  test('non-numeric evidence is coerced to zero, not NaN', () => {
    const raw = JSON.stringify({
      version: STATE_VERSION,
      files: { 'a.ts': [{ h: 'x', e: { visibleMs: 'lots', dwellEvents: null } }] },
    });
    const e = parseState(raw).files['a.ts'][0].e;
    assert.equal(e.visibleMs, 0);
    assert.equal(e.dwellEvents, 0);
  });

  test('an unknown provenance falls back to unknown', () => {
    const raw = JSON.stringify({
      version: STATE_VERSION,
      files: { 'a.ts': [{ h: 'x', e: { provenance: 'hand-carved' } }] },
    });
    assert.equal(parseState(raw).files['a.ts'][0].e.provenance, 'unknown');
  });

  test('garbage input yields an empty state', () => {
    assert.deepEqual(parseState('not json').files, {});
    assert.deepEqual(parseState('[]').files, {});
    assert.deepEqual(parseState('null').files, {});
  });
});

describe('pruneState', () => {
  const now = 1_700_000_000_000;
  const month = 30 * 24 * 60 * 60 * 1000;

  test('drops files nobody has looked at in a month', () => {
    const state = emptyState();
    state.files['stale.ts'] = [{ h: 'a', i: 0, e: { ...emptyEvidence(), lastSeen: now - month - 1000 } }];
    state.files['fresh.ts'] = [{ h: 'b', i: 0, e: { ...emptyEvidence(), lastSeen: now - 1000 } }];

    const pruned = pruneState(state, month, now);
    assert.equal('stale.ts' in pruned.files, false);
    assert.equal('fresh.ts' in pruned.files, true);
  });

  test('keeps entries that never recorded a timestamp', () => {
    const state = emptyState();
    state.files['a.ts'] = [{ h: 'a', i: 0, e: emptyEvidence() }];
    assert.equal('a.ts' in pruneState(state, month, now).files, true);
  });
});

describe('parseAiRegions', () => {
  test('reads declared regions', () => {
    const regions = parseAiRegions('{"src/api.ts": [[10, 42], [80, 96]]}');
    assert.deepEqual(regions['src/api.ts'], [[10, 42], [80, 96]]);
  });

  test('ignores malformed ranges but keeps valid ones', () => {
    const regions = parseAiRegions('{"a.ts": [[1, 2], "nope", [3], [4, 5]]}');
    assert.deepEqual(regions['a.ts'], [[1, 2], [4, 5]]);
  });

  test('clamps line numbers to at least 1', () => {
    assert.deepEqual(parseAiRegions('{"a.ts": [[0, -3]]}')['a.ts'], [[1, 1]]);
  });

  test('bad json is not an error, just no declarations', () => {
    assert.deepEqual(parseAiRegions('{'), {});
    assert.deepEqual(parseAiRegions('[]'), {});
  });
});
