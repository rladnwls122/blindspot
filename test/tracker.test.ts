import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config';
import { evaluate } from '../src/core/evidence';
import { hashLine } from '../src/core/hash';
import { emptyState } from '../src/core/store';
import { emptyEvidence } from '../src/core/types';

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
    onDidRenameFiles: () => noop,
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
  tracker = new AttentionTracker({ root: ROOT }, cfg, {}, () => {});
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
    // 60 lines on screen, caret at the top, held still for twelve seconds.
    const editor = makeEditor(60, 0, 59, 0);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(12000);

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

  test('reading at a human pace is read; racing through the same lines is not', () => {
    // 40-line viewport, caret stepping down one line at a time.
    const pace = (msPerLine: number) => {
      const editor = makeEditor(200, 0, 39, 0);
      world.visibleEditors = [editor];
      world.activeEditor = editor;
      startTracker();
      for (let line = 0; line < 80; line++) {
        const top = Math.max(0, line - 20);
        editor.visibleRanges = [{ start: { line: top }, end: { line: top + 39 } }];
        editor.selection = { active: { line } };
        hold(msPerLine);
      }
      let read = 0;
      for (let l = 20; l <= 60; l++) if (evaluate(seen(l), DEFAULT_CONFIG).reviewed) read += 1;
      tracker.dispose();
      return read;
    };
    assert.equal(pace(2000), 41, 'two seconds a line reads everything');
    assert.equal(pace(250) < 5, true, 'a quarter second a line reads almost nothing');
  });

  test('a file left open with nobody at the keyboard stops earning', () => {
    const editor = makeEditor(20, 0, 19, 5);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker({ ...DEFAULT_CONFIG, idleAfterMs: 5000 });
    hold(5000);
    const atIdle = seen(6).focusedMs;
    assert.equal(atIdle > 0, true);

    // Ten more minutes of the same screen, no caret, scroll or edit.
    hold(10 * 60 * 1000);
    assert.equal(seen(6).focusedMs, atIdle, 'walking away is not reading');

    // Moving the viewport is a sign of life; the clock starts again.
    editor.visibleRanges = [{ start: { line: 1 }, end: { line: 20 } }];
    hold(1000);
    assert.equal(seen(6).focusedMs > atIdle, true);
  });

  test('the attention budget follows the mouse when it moved more recently than the caret', () => {
    // 60 lines on screen, caret parked on line 1, reading with the mouse
    // around line 45. Without the pointer the budget would land on line 1.
    const editor = makeEditor(60, 0, 59, 0);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(250);
    tracker.notePointer(editor.document, 45);
    // The budget is shared with the lines on both sides of a mid-screen
    // focus, so a line there takes longer to read than one at the top edge.
    hold(24000);

    assert.equal(evaluate(seen(45), DEFAULT_CONFIG).reviewed, true, 'the line under the mouse was read');
    assert.equal(evaluate(seen(1), DEFAULT_CONFIG).reviewed, false, 'the line under the idle caret was not');
    assert.equal(seen(45).pointerHits, 1, 'and the rest itself is evidence');
    assert.equal(evaluate(seen(45), DEFAULT_CONFIG).interacted, true);
  });

  test('a scroll makes the mouse position stale, and the caret takes over again', () => {
    const editor = makeEditor(400, 0, 59, 5);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    hold(250);
    tracker.notePointer(editor.document, 50);
    hold(2000);
    const beforeScroll = seen(50).focusedMs;
    assert.equal(beforeScroll > seen(6).focusedMs, true, 'the mouse line led while the mouse was fresh');

    // The text moved under a still mouse: line 50 is now somewhere else.
    editor.visibleRanges = [{ start: { line: 100 }, end: { line: 159 } }];
    editor.selection = { active: { line: 120 } };
    hold(24000);
    assert.equal(evaluate(seen(121), DEFAULT_CONFIG).reviewed, true, 'the caret is the focus again');
    assert.equal(seen(50).focusedMs, beforeScroll, 'the old mouse line earned nothing more');
  });

  test('the same line hovered twice in quick succession is one rest', () => {
    const editor = makeEditor(20, 0, 19, 0);
    world.visibleEditors = [editor];
    world.activeEditor = editor;
    startTracker();
    tracker.notePointer(editor.document, 7);
    mock.timers.tick(100);
    tracker.notePointer(editor.document, 7);
    assert.equal(seen(7).pointerHits, 1);
    mock.timers.tick(2000);
    tracker.notePointer(editor.document, 7);
    assert.equal(seen(7).pointerHits, 2);
  });

  test('review actions are counted, and completing a review sets the baseline', () => {
    startTracker();
    tracker.recordActivity('jumps');
    tracker.recordActivity('jumps');
    tracker.setBaseline('0123456789abcdef0123456789abcdef01234567');
    assert.equal(tracker.activityCounts.jumps, 2);
    assert.equal(tracker.activityCounts.completions, 1);
    assert.equal(tracker.reviewBaseline?.commit, '0123456789abcdef0123456789abcdef01234567');
    const snap = tracker.snapshot(() => undefined);
    assert.equal(snap.activity.jumps, 2);
    assert.equal(snap.baseline?.commit.length, 40);
  });

  test('a renamed file keeps the reading recorded under its old name', () => {
    const state = emptyState();
    state.files['src/old.ts'] = [
      {
        h: hashLine('line 0'),
        i: 0,
        e: { ...emptyEvidence(), visibleMs: 5000, focusedMs: 5000, dwellEvents: 1, caretHits: 1 },
      },
    ];
    tracker = new AttentionTracker({ root: ROOT }, DEFAULT_CONFIG, {}, () => {});
    tracker.start(state);

    tracker.followRename('src/old.ts', 'src/new.ts');
    tracker.primeFromText('src/new.ts', ['line 0', 'line 1']);

    assert.equal(tracker.getEvidence('src/new.ts', 1)?.focusedMs, 5000, 'the line kept its evidence');
    assert.deepEqual(tracker.files(), ['src/new.ts'], 'nothing is left under the old name');
  });

  test('a folder rename carries every file beneath it, and only those', () => {
    const state = emptyState();
    const e = { ...emptyEvidence(), focusedMs: 3000 };
    state.files['src/a/x.ts'] = [{ h: hashLine('x'), i: 0, e }];
    state.files['src/a/deep/y.ts'] = [{ h: hashLine('y'), i: 0, e }];
    // A sibling whose name merely starts the same way.
    state.files['src/ab.ts'] = [{ h: hashLine('z'), i: 0, e }];
    tracker = new AttentionTracker({ root: ROOT }, DEFAULT_CONFIG, {}, () => {});
    tracker.start(state);

    tracker.followRename('src/a', 'src/b');

    assert.deepEqual(tracker.files().sort(), ['src/ab.ts', 'src/b/deep/y.ts', 'src/b/x.ts']);
  });

  test('evidence that lands on a name already open is saved, then merged, not lost', () => {
    const state = emptyState();
    state.files['src/old.ts'] = [
      { h: hashLine('line 0'), i: 0, e: { ...emptyEvidence(), humanEdits: 2, focusedMs: 100 } },
    ];
    tracker = new AttentionTracker({ root: ROOT }, DEFAULT_CONFIG, {}, () => {});
    tracker.start(state);
    // new.ts is open and already has a ledger of its own.
    tracker.markReviewed('src/new.ts', 2);

    tracker.followRename('src/old.ts', 'src/new.ts');

    // Saved before anything anchored the moved evidence: it rides along.
    const snap = tracker.snapshot(() => ['line 0', 'line 1']);
    assert.equal(
      snap.files['src/new.ts'].some((l: { e: { humanEdits: number } }) => l.e.humanEdits === 2),
      true,
      'the moved evidence survives a snapshot',
    );
    assert.equal('src/old.ts' in snap.files, false);

    // Touched: it is anchored to the text and folded into the open ledger.
    tracker.primeFromText('src/new.ts', ['line 0', 'line 1']);
    assert.equal(tracker.getEvidence('src/new.ts', 1)?.humanEdits, 2);
    assert.equal(tracker.files().includes('src/old.ts'), false);
  });
});
