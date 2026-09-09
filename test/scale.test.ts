import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config';
import { buildReport, pageData, type ReportSources } from '../src/core/coverage';
import type { FileDiff } from '../src/core/types';

/**
 * What a refresh costs on a diff far larger than anyone reviews at once.
 *
 * `docs/PLAN.md` v0.2 item 2 left this open: "500 changed files, `collectDiff`
 * + `buildReport` every four seconds — is that bearable? If not, cache the diff
 * and recompute only the changed files." The answer turned out to be yes, with
 * room to spare, so the cache was never built. That answer is only worth
 * anything if something keeps checking it.
 *
 * The assertion that matters is structural, not a stopwatch: every file's text
 * is fetched exactly once. In the editor that fetch is a `readFileSync`, so a
 * change that reads a file twice per pass doubles the I/O of a background task
 * running every four seconds, and would not show up in any other test.
 */

interface Synthetic {
  diffs: FileDiff[];
  sources: ReportSources;
  reads: () => number;
}

function synthetic(files: number, linesPerFile: number, changedPerFile: number): Synthetic {
  const texts = new Map<string, string[]>();
  const diffs: FileDiff[] = [];
  for (let i = 0; i < files; i++) {
    // Spread over directories, so the risk rules match on real-looking paths.
    const file = `src/mod${i % 25}/f${i}.ts`;
    const lines: string[] = [];
    for (let l = 0; l < linesPerFile; l++) {
      lines.push(`export const v${i}_${l} = compute(${l}, base${l});`);
    }
    texts.set(file, lines);
    const addedLines: number[] = [];
    for (let l = 0; l < changedPerFile; l++) addedLines.push(l * 7 + 1);
    diffs.push({ file, addedLines, modifiedLines: [], deletedLines: 0, binary: false });
  }

  let reads = 0;
  return {
    diffs,
    sources: {
      getText: (file) => {
        reads += 1;
        return texts.get(file);
      },
      getEvidence: () => undefined,
    },
    reads: () => reads,
  };
}

/** The declared default of `blindspot.refreshIntervalMs`, from the manifest. */
function refreshIntervalMs(): number {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  ) as { contributes: { configuration: { properties: Record<string, { default: number }> } } };
  const declared = manifest.contributes.configuration.properties['blindspot.refreshIntervalMs'];
  assert.equal(typeof declared?.default, 'number', 'the refresh interval must still be declared');
  return declared.default;
}

describe('a diff far bigger than anyone reviews at once', () => {
  test('every file is read once, and every changed line is scored', () => {
    const big = synthetic(500, 200, 20);
    const report = buildReport(big.diffs, big.sources, DEFAULT_CONFIG, 'HEAD');

    assert.equal(big.reads(), 500, 'one fetch per file, not one per line or per hunk');
    assert.equal(report.totalChangedLines, 10_000);
    assert.equal(report.unseenLines, 10_000, 'no evidence was supplied, so none of it is read');
    assert.equal(report.files.length, 500);
  });

  test('the page behind the panel reads each file once too', () => {
    const big = synthetic(500, 200, 20);
    const data = pageData(big.diffs, big.sources, DEFAULT_CONFIG);
    assert.equal(big.reads(), 500);
    assert.equal(data.files.length, 500);
  });

  test('a report costs a fraction of the interval it is rebuilt on', () => {
    // The budget is the real one, read from the setting rather than written
    // down here: blindspot.refreshIntervalMs is the period this runs on in the
    // background. Measured at roughly a tenth of it, so this fires only if
    // something has become an order of magnitude slower — the case that sends
    // a laptop's fan up while nobody is even reviewing.
    const budget = refreshIntervalMs();
    for (const [files, changed] of [
      [500, 20],
      [2000, 20],
      [500, 200],
    ] as const) {
      const big = synthetic(files, 200, changed);
      const started = Date.now();
      buildReport(big.diffs, big.sources, DEFAULT_CONFIG, 'HEAD');
      const took = Date.now() - started;
      assert.equal(
        took < budget,
        true,
        `${files} files x ${changed} changed took ${took}ms, past the ${budget}ms refresh interval`,
      );
    }
  });

  test('one enormous file is no worse than many small ones', () => {
    // The other shape of a large diff: a generated file, a vendored bundle.
    const one = synthetic(1, 50_000, 50_000);
    const started = Date.now();
    const report = buildReport(one.diffs, one.sources, DEFAULT_CONFIG, 'HEAD');
    assert.equal(Date.now() - started < refreshIntervalMs(), true);
    assert.equal(report.totalChangedLines, 50_000);
    assert.equal(one.reads(), 1);
  });
});
