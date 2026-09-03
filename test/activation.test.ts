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
 * Two scenarios used to be dead ends. Activating with no folder returned
 * silently, which left every contributed command unregistered and the palette
 * answering "command not found". Activating in a folder that is not a git
 * repository refused to start at all — but reading code needs a folder, not a
 * repository, so that now starts in reading mode and only the git-backed
 * commands explain what is missing.
 */

interface Stub {
  commands: Map<string, (...args: any[]) => any>;
  warnings: string[];
  errors: string[];
  folders: Array<{ uri: { fsPath: string } }>;
  /** Make one late step of startup blow up, to test the failure path. */
  failHoverRegistration: boolean;
  folderListeners: Array<() => void>;
  treeViews: Array<{ id: string; provider: any }>;
  /** Settings written through `getConfiguration().update`. */
  settings: Record<string, unknown>;
}

let stub: Stub;

function makeVscode(): any {
  const disposable = (dispose: () => void) => ({ dispose });
  return {
    workspace: {
      get workspaceFolders() {
        return stub.folders.length > 0 ? stub.folders : undefined;
      },
      getConfiguration: () => ({
        get: (k: string, d: unknown) => (k in stub.settings ? stub.settings[k] : d),
        update: async (k: string, v: unknown) => {
          stub.settings[k] = v;
        },
      }),
      onDidChangeWorkspaceFolders: (fn: () => void) => {
        stub.folderListeners.push(fn);
        return disposable(() => {});
      },
      onDidChangeConfiguration: () => disposable(() => {}),
      isTrusted: true,
      onDidGrantWorkspaceTrust: () => disposable(() => {}),
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
      showQuickPick: () => Promise.resolve(undefined),
      onDidChangeWindowState: () => disposable(() => {}),
      onDidChangeTextEditorSelection: () => disposable(() => {}),
      onDidChangeVisibleTextEditors: () => disposable(() => {}),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
        stub.treeViews.push({ id, provider: options.treeDataProvider });
        return { dispose() {}, description: undefined, badge: undefined, message: undefined };
      },
      showInputBox: () => Promise.resolve(undefined),
      setStatusBarMessage: () => disposable(() => {}),
    },
    languages: {
      registerHoverProvider: () => {
        if (stub.failHoverRegistration) throw new Error('hover registration exploded');
        return disposable(() => {});
      },
    },
    commands: {
      registerCommand: (id: string, fn: (...args: any[]) => any) => {
        // Real VS Code refuses a second registration of the same id.
        if (stub.commands.has(id)) throw new Error(`command '${id}' already exists`);
        stub.commands.set(id, fn);
        return disposable(() => {
          if (stub.commands.get(id) === fn) stub.commands.delete(id);
        });
      },
      executeCommand: (id: string, ...args: any[]) => stub.commands.get(id)?.(...args),
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
      parse: (s: string) => ({ toString: () => s }),
    },
    MarkdownString: class {
      constructor(public value = '') {}
    },
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
      constructor(public label: string, public collapsibleState: number) {}
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
      treeViews: [],
      settings: {},
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

  test('it starts in reading mode; only the git-backed commands explain what is missing', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());
    assert.deepEqual(stub.errors, []);

    await stub.commands.get('blindspot.installGitHook')!();
    await stub.commands.get('blindspot.completeReview')!();
    assert.equal(stub.warnings.length, 2);
    for (const w of stub.warnings) assert.match(w, /git repository/i);

    // The tracker is live: navigating must not complain about a missing repo.
    await stub.commands.get('blindspot.reviewBlindspot')!();
    assert.equal(stub.warnings.length, 2);
    assert.deepEqual(stub.errors, []);
  });

  test('the sidebar is registered under the id package.json contributes', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const ids = Object.values(pkg.contributes.views as Record<string, Array<{ id: string }>>)
      .flat()
      .map((v) => v.id);
    assert.deepEqual(stub.treeViews.map((v) => v.id), ids);
    // The provider answers for the root without a report having been built.
    const provider = stub.treeViews[0].provider;
    const roots = provider.getChildren();
    assert.equal(Array.isArray(roots), true);
    assert.equal(roots.length > 0, true);
    for (const node of roots) assert.ok(provider.getTreeItem(node));
  });

  test('without git, diff mode cannot be chosen and the mode toggle says why', async () => {
    const dir = tempDir();
    stub.folders = [{ uri: { fsPath: dir } }];
    await extension.activate(fakeContext());
    await stub.commands.get('blindspot.toggleMode')!();
    assert.equal(stub.settings['mode'], undefined, 'nothing was written');
    assert.match(stub.warnings.at(-1) ?? '', /git repository/i);
    await stub.commands.get('blindspot.selectBase')!();
    assert.match(stub.warnings.at(-1) ?? '', /git repository/i);
  });

  test('with no folder open at all, it says so', async () => {
    await extension.activate(fakeContext());
    await stub.commands.get('blindspot.reviewBlindspot')!();
    assert.match(stub.warnings[0], /open folder/i);
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
      treeViews: [],
      settings: {},
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
    // They are the fallback handlers: the failed controller released its ids
    // (the stub throws on a duplicate registration, as VS Code does), so
    // running one explains what is wrong instead of driving a dead controller.
    assert.equal(stub.commands.has('blindspot.showReport'), true);
    await stub.commands.get('blindspot.showReport')!();
    assert.equal(stub.errors.length, 2, 'the retry fails the same way and says so');
  });

  test('with tracking disabled, the sidebar says so rather than going stale', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    stub.folders = [{ uri: { fsPath: repo } }];
    stub.settings['enabled'] = false;
    await extension.activate(fakeContext());

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const view = stub.treeViews.find((v) => v.id === pkg.contributes.views.scm[0].id);
    assert.ok(view, 'the sidebar is registered');
    const rows = view!.provider.getChildren();
    assert.equal(rows.length, 1);
    assert.match(rows[0].label, /off/i);
    assert.match(rows[0].label, /blindspot\.enabled/);
  });

  test('a command that fails says so in its own words', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    stub.folders = [{ uri: { fsPath: repo } }];
    await extension.activate(fakeContext());

    // The stub has no createWebviewPanel, so reaching the panel is the
    // failure. It must surface as Blindspot's own message rather than as VS
    // Code's generic "command failed" naming the id.
    await stub.commands.get('blindspot.showReport')!();
    assert.equal(stub.errors.length, 1);
    assert.match(stub.errors[0], /^Blindspot: .*createWebviewPanel/);
  });

  test('toggling the mode writes the workspace setting and flips it back', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    stub.folders = [{ uri: { fsPath: repo } }];
    await extension.activate(fakeContext());

    await stub.commands.get('blindspot.toggleMode')!();
    assert.equal(stub.settings['mode'], 'reading', 'auto resolves to diff in a repository, so the toggle reads');
    await stub.commands.get('blindspot.toggleMode')!();
    assert.equal(stub.settings['mode'], 'diff');
    assert.deepEqual(stub.errors, []);
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
});
