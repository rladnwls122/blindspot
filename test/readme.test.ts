import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderCard, renderScore } from '../src/core/render';
import { runScenario } from '../demo/simulate';

/**
 * The README says of its card: "this is not a mockup — run `npm run demo` and
 * the numbers come out of the real scoring model". That sentence is a claim
 * about behaviour, so it is a test.
 *
 * It stopped being true once, quietly: the model was retuned and the printed
 * card moved from 64% to 55% while the README kept saying 64%. A tool whose
 * whole subject is people trusting numbers they did not check cannot ship a
 * front page that does exactly that.
 *
 * When this fails, the fix is to paste what the demo now prints into both
 * READMEs, not to loosen the assertion.
 */

const ROOT = path.resolve(__dirname, '../..');
const READMES = ['README.md', 'README.en.md'];

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

describe('the README quotes the model, not a mockup', () => {
  const report = runScenario();

  test('the card is the one the demo prints', () => {
    const card = renderCard(report, { color: false });
    for (const file of READMES) {
      assert.equal(
        read(file).includes(card),
        true,
        `${file} does not contain the card the model produces:\n${card}`,
      );
    }
  });

  test('the Review Score block is too, down to the bar', () => {
    // The label column differs by language below the numbers, so the rows the
    // two READMEs share are what is checked: the bar, and every metric line.
    const rows = renderScore(report, { color: false })
      .split('\n')
      .filter((r) => r.trim().length > 0 && !r.startsWith('Review Score'));
    for (const file of READMES) {
      const text = read(file);
      for (const row of rows) {
        assert.equal(text.includes(row), true, `${file} is missing the row: ${row}`);
      }
    }
  });

  test('both READMEs describe the same session', () => {
    // They are translations of one document. If one is updated and the other
    // is not, the card above passes in one file and fails in the other, which
    // is the case this catches early.
    const [ko, en] = READMES.map(read);
    const card = renderCard(report, { color: false });
    assert.equal(ko.includes(card) && en.includes(card), true);
  });
});
