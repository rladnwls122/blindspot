import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Activation is the one code path every user hits before any of the model
 * runs, and it is the one path the unit tests could not reach because it
 * imports `vscode`. So we supply just enough of `vscode` to run it.
 *
 * The scenario under test is the one that used to be a dead end: the extension
 * activates somewhere that is not a git repository. Previously it returned
 * silently, which left every contributed command unregistered and the palette
 * answering "command not found" — the worst possible way to explain a missing
 * prerequisite.
 */

interface Stub {
  commands: Map<string, (...args: any[]) => any>;
  warnings: string[];
  errors: string[];
  folders: Array<{ uri: { fsPath: string } }>;
  /** Make one late step of startup blow up, to test the failure path. */
  failHoverRegistration: boolean;
  folderListeners: Array<() => void>;
  /** Tree data providers by view id, as `createTreeView` received them. */
  treeViews: Map<string, any>;
  /** `setContext` calls, keyed by context key. */
  contextKeys: Map<string, unknown>;
}

let stub: Stub;

function makeVscode(): any {
  const disposable = (dispose: () => void) => ({ dispose });
  return {
    workspace: {
      get workspaceFolders() {
        return stub.folders.length > 0 ? stub.folders : undefined;
      },
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => {} }),
      onDidChangeWorkspaceFolders: (fn: () => void) => {
        stub.folderListeners.push(fn);
        return disposable(() => {});
      },
      onDidChangeConfiguration: () => disposable(() => {}),
      onDidSaveTextDocument: () => disposable(() => {}),
      onDidCloseTextDocument: () => disposable(() => {}),
      onDidChangeTextDocument: () => disposable(() => {}),
      textDocuments: [],
    },
    window: {
      state: { focused: true },
      activeTextEditor: undefined,
      visibleTextEditors: [],
      showWarningMessage: (m: string) => {
        stub.warnings.push(m);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (m: string) => {
        stub.errors.push(m);
        return Promise.resolve(undefined);
      },
      showInformationMessage: () => Promise.resolve(undefined),
      onDidChangeWindowState: () => disposable(() => {}),
      onDidChangeTextEditorSelection: () => disposable(() => {}),
      onDidChangeVisibleTextEditors: () => disposable(() => {}),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
        stub.treeViews.set(id, options.treeDataProvider);
        return disposable(() => stub.treeViews.delete(id));
      },
    },
    languages: {
      registerHoverProvider: () => {
        if (stub.failHoverRegistration) throw new Error('hover registration exploded');
        return disposable(() => {});
      },
    },
    commands: {
      registerCommand: (id: string, fn: (...args: any[]) => any) => {
        stub.commands.set(id, fn);
        return disposable(() => stub.commands.delete(id));
      },
      executeCommand: (id: string, ...args: any[]) => {
        if (id === 'setContext') {
          stub.contextKeys.set(args[0], args[1]);
          return Promise.resolve();
        }
        return stub.commands.get(id)?.(...args);
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
    Disposable: class {},
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1 },
    ConfigurationTarget: { Workspace: 2 },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    Range: class {},
    Selection: class {},
    ThemeColor: class {},
    ThemeIcon: class {},
    TreeItem: class {
      constructor(public label: string) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TextEditorRevealType: { InCenter: 2 },
    OverviewRulerLane: { Right: 4 },
    EventEmitter: class {
      event = () => disposable(() => {});
      fire() {}
      dispose() {}
    },
  };
}

// Intercept `require('vscode')` before the extension module is loaded.
const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return makeVscode();
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const extension = require('../src/extension/extension');

let context: { subscriptions: Array<{ dispose(): void }>; extensionUri: { fsPath: string } };

function fakeContext() {
  context = { subscriptions: [], extensionUri: { fsPath: process.cwd() } };
  return context;
}

/**
 * VS Code disposes `context.subscriptions` itself; nothing does that here, so
 * a started controller would leave its refresh interval and file watcher
 * running and the test process would never exit.
 */
function teardown(): void {
  extension.deactivate();
  for (const d of context?.subscriptions ?? []) {
    try {
      d.dispose();
    } catch {
      /* a stub disposable that throws is not what is under test */
    }
  }
  if (context) context.subscriptions = [];
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-activate-'));
}

describe('activation outside a git repository', { concurrency: 1 }, () => {
  beforeEach(() => {
    stub = {
      commands: new Map(),
      warnings: [],
      errors: [],
      folders: [],
      folderListeners: [],
      failHoverRegistration: false,
      treeViews: new Map(),
      contextKeys: new Map(),
    };
  });
  afterEach(teardown);

  test('every contributed command is still registered', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());

    // Exactly the ids package.json contributes — a command in the palette that
    // resolves to nothing is a worse failure than a command that explains.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const contributed = pkg.contributes.commands.map((c: { command: string }) => c.command);
    for (const id of contributed) {
      assert.equal(stub.commands.has(id), true, `${id} must be registered`);
    }
  });

  test('running one explains what is missing instead of throwing', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());

    await stub.commands.get('blindspot.showReport')!();
    assert.equal(stub.warnings.length, 1);
    assert.match(stub.warnings[0], /git repository/i);
    assert.equal(stub.errors.length, 0);
  });

  test('with no folder open at all, it says so', async () => {
    await extension.activate(fakeContext());
    await stub.commands.get('blindspot.reviewBlindspot')!();
    assert.match(stub.warnings[0], /open folder/i);
  });

  test('the sidebar view has a provider, and its welcome text knows there is no repo', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());

    // A view contributed in package.json with nobody behind it shows "no data
    // provider registered" — the least helpful thing an empty sidebar can say.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const viewId = pkg.contributes.views.blindspot[0].id;
    const provider = stub.treeViews.get(viewId);
    assert.ok(provider, `a tree data provider must be registered for ${viewId}`);
    assert.deepEqual(provider.getChildren(), []);
    assert.equal(stub.contextKeys.get('blindspot.repo'), false);
  });
});

describe('activation inside a git repository', { concurrency: 1 }, () => {
  beforeEach(() => {
    stub = {
      commands: new Map(),
      warnings: [],
      errors: [],
      folders: [],
      folderListeners: [],
      failHoverRegistration: false,
      treeViews: new Map(),
      contextKeys: new Map(),
    };
  });
  afterEach(teardown);

  test('a failure during startup is reported, not swallowed into a dead extension', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    stub.folders = [{ uri: { fsPath: repo } }];
    stub.failHoverRegistration = true;

    await extension.activate(fakeContext());

    assert.equal(stub.errors.length, 1);
    assert.match(stub.errors[0], /could not start/i);
    // And the commands still exist, so the palette explains rather than 404s.
    assert.equal(stub.commands.has('blindspot.showReport'), true);
  });

  test('a repository in second position in a multi-root workspace is found', async () => {
    const plain = tempDir();
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });

    stub.folders = [{ uri: { fsPath: plain } }, { uri: { fsPath: repo } }];
    await extension.activate(fakeContext());

    // The controller took over: the commands are real handlers, so invoking one
    // no longer produces the "needs a git repository" warning.
    await stub.commands.get('blindspot.markFileReviewed')!();
    assert.equal(
      stub.warnings.filter((w) => /git repository/i.test(w)).length,
      0,
      'should not have fallen back',
    );
    // A brand-new repository has no HEAD to diff against; starting up in one
    // must not be an error the user has to see.
    assert.deepEqual(stub.errors, []);
  });

  test('the dashboard button opens the same panel as Show Review Report', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    stub.folders = [{ uri: { fsPath: repo } }];
    await extension.activate(fakeContext());

    assert.equal(stub.contextKeys.get('blindspot.repo'), true);
    // Both ids are real handlers, and the run-dashboard one reaches the panel
    // — the stub has no createWebviewPanel, so reaching it is the failure. A
    // command that fails must say so in Blindspot's own words rather than
    // surface as VS Code's generic "command failed" naming the id.
    assert.equal(stub.commands.has('blindspot.runDashboard'), true);
    await stub.commands.get('blindspot.runDashboard')!();
    assert.equal(stub.errors.length, 1);
    assert.match(stub.errors[0], /^Blindspot: .*createWebviewPanel/);
    assert.equal(stub.warnings.filter((w) => /git repository/i.test(w)).length, 0);
  });
});
