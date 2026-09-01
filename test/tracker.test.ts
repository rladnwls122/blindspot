import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config';
import { evaluate } from '../src/core/evidence';
import { emptyState } from '../src/core/store';

/**
 * The collector, driven through a fake editor and a fake clock.
 *
 * Everything the model refuses to count — screen time while the window is not
 * focused, lines flying past faster than anyone reads, the far edge of a tall
 * viewport — is enforced here rather than in `evaluate()`. Those guards are the
 * difference between a measurement and a flattering number, and until now
 * nothing exercised them, because they need `vscode`.
 */

const ROOT = path.resolve('/repo');
const FILE = 'src/app.ts';

interface Editor {
  document: any;
  visibleRanges: Array<{ start: { line: number }; end: { line: number } }>;
  viewColumn: number;
  selection: { active: { line: number } };
}

const world = {
  focused: true,
  visibleEditors: [] as Editor[],
  activeEditor: undefined as Editor | undefined,
};

const noop = { dispose() {} };
const vscodeStub = {
  window: {
    get state() {
      return { focused: world.focused };
    },
    get visibleTextEditors() {
      return world.visibleEditors;
    },
    get activeTextEditor() {
      return world.activeEditor;
    },
    onDidChangeWindowState: () => noop,
    onDidChangeTextEditorSelection: () => noop,
    onDidChangeVisibleTextEditors: () => noop,
  },
  workspace: {
    onDidChangeTextDocument: () => noop,
    onDidCloseTextDocument: () => noop,
  },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
};

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AttentionTracker } = require('../src/extension/tracker');

function makeEditor(lineCount: number, first: number, last: number, caret: number): Editor {
  return {
    document: {
      uri: { scheme: 'file', fsPath: path.join(ROOT, ...FILE.split('/')), toString: () => FILE },
      lineCount,
      lineAt: (i: number) => ({ text: `line ${i}` }),
    },
    visibleRanges: [{ start: { line: first }, end: { line: last } }],
    viewColumn: 1,
    selection: { active: { line: caret } },
  };
}

let tracker: any;

function startTracker(cfg = DEFAULT_CONFIG): void {
  tracker = new AttentionTracker({ root: ROOT, gitDir: ROOT, hooksDir: ROOT }, cfg, {}, () => {});
  tracker.start(emptyState());
}

/**
 * Hold the viewport still for `ms`, one 250 ms tick at a time.
 *
 * Advancing the mock clock in one jump is not the same thing: the tracker
 * would see a single tick that lasted the whole interval and discard it as a
 * suspended machine, which is exactly the guard it is supposed to have.
 */
function hold(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) mock.timers.tick(250);
}

/** 1-based, matching the ledger. */
function seen(line: number) {
  return tracker.getEvidence(FILE, line);
}

describe('AttentionTracker', { concurrency: 1 }, () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    world.focused = true;
    world.visibleEditors = [];
    world.activeEditor = undefined;
  });

  afterEach(() => {
    tracker?.dispose();
    tracker = undefined;
    mock.timers.reset();
  });

  test('a tall viewport does not report its far edge as read', () => {
    // 60 lines on screen, caret at the top, held still for four seconds.
    const editor = makeEditor(60, 0, 59, 0);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(4000);

    assert.equal(evaluate(seen(1), DEFAULT_CONFIG).reviewed, true, 'the caret line was read');
    assert.equal(evaluate(seen(60), DEFAULT_CONFIG).reviewed, false, 'the far edge was not');
    assert.equal(seen(60).visibleMs < seen(1).visibleMs, true, 'and earned less time');
    assert.equal(seen(60).dwellEvents, 0, 'a pause happens somewhere, not everywhere');
  });

  test('nothing at all is credited while the window is not focused', () => {
    const editor = makeEditor(20, 0, 19, 5);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    world.focused = false;
    startTracker();
    hold(10_000);

    // A file left on screen behind another application for ten seconds.
    assert.equal(seen(6), undefined);
  });

  test('scrolling faster than anyone reads earns nothing', () => {
    const editor = makeEditor(4000, 0, 39, 0);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(250);

    const before = seen(1000)?.visibleMs ?? 0;
    // ~160 lines/second, well past the 45 lines/second guard.
    for (let i = 0; i < 8; i++) {
      const top = 1000 + i * 40;
      editor.visibleRanges = [{ start: { line: top }, end: { line: top + 39 } }];
      hold(250);
    }
    const flownPast = seen(1200);
    assert.equal(flownPast === undefined || flownPast.visibleMs === 0, true);
    assert.equal(seen(1000)?.visibleMs ?? 0, before, 'the first screen kept only what it earned');
  });

  test('a background split earns visible time but never focused time', () => {
    const active = makeEditor(20, 0, 19, 0);
    const background = makeEditor(20, 0, 19, 0);
    background.viewColumn = 2;
    world.visibleEditors = [background];
    world.activeEditor = active; // a different editor group has focus
    startTracker();
    hold(5000);

    assert.equal(seen(1).visibleMs > 0, true);
    assert.equal(seen(1).focusedMs, 0);
    assert.equal(evaluate(seen(1), DEFAULT_CONFIG).reviewed, false);
  });

  test('a machine that was asleep does not report an hour of reading', () => {
    const editor = makeEditor(20, 0, 19, 5);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(1000);
    const before = seen(6).visibleMs;
    assert.equal(before > 0, true);

    // The lid closed and the clock jumped: one enormous tick, with the same
    // file still on screen the whole time.
    mock.timers.tick(60 * 60 * 1000);
    assert.equal(seen(6).visibleMs, before, 'a closed laptop is not diligent reading');
  });

  test('coming back to a line later is recorded as a second viewing episode', () => {
    const editor = makeEditor(400, 0, 39, 10);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(2000);
    assert.equal(seen(11).revisits, 0);

    // Scroll far away for longer than revisitGapMs, then come back.
    editor.visibleRanges = [{ start: { line: 300 }, end: { line: 339 } }];
    editor.selection = { active: { line: 310 } };
    hold(DEFAULT_CONFIG.revisitGapMs + 1000);

    editor.visibleRanges = [{ start: { line: 0 }, end: { line: 39 } }];
    editor.selection = { active: { line: 10 } };
    hold(1000);

    assert.equal(seen(11).revisits, 1);
  });
});
