import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_CONFIG, type BlindspotConfig } from '../core/config';
import { buildReport, pageData, wholeFileTarget, type ReportSources } from '../core/coverage';
import { MODE_LABEL, shortRef } from '../core/labels';
import { pct } from '../core/score';
import type { DiffReport, FileDiff, TargetMode } from '../core/types';
import type { AiRegions } from '../core/store';
import { CommitWatcher } from './commitwatch';
import { Decorations } from './decorations';
import { EvidenceHover } from './hover';
import { collectDiff, commitExists, findGitContext, headCommit } from './git';
import { Navigator } from './navigator';
import { ReportPanel, type PanelMessage, type PanelView } from './panel';
import { StatusBar } from './statusbar';
import { installHook, loadAiRegions, loadConfig, loadState, saveState } from './storage';
import { AttentionTracker, docLines } from './tracker';
import { BlindspotTree } from './tree';
import { findWorkspace, workspaceFromGit, type WorkspaceContext } from './workspace';

const SAVE_DEBOUNCE_MS = 5000;
const DISABLED_NOTE = 'Tracking is off (blindspot.enabled)';
/** Above this a file is not read for the report; a diff in it is not reviewable text. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** A path that stays inside the repository when joined to its root. */
function isRepoRelative(file: string): boolean {
  if (!file || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return false;
  // Report paths use forward slashes, but a backslash is a separator on the
  // platform this joins on, so both count.
  return !file.split(/[\\/]/).some((segment) => segment === '..');
}

let controller: Controller | undefined;

/** Every command the extension contributes, in package.json order. */
const COMMAND_IDS = [
  'blindspot.showReport',
  'blindspot.reviewBlindspot',
  'blindspot.switchMode',
  'blindspot.toggleMode',
  'blindspot.selectBase',
  'blindspot.toggleDecorations',
  'blindspot.markFileReviewed',
  'blindspot.resetSession',
  'blindspot.installGitHook',
  'blindspot.completeReview',
  'blindspot.refresh',
] as const;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!(await tryStart(context))) {
    // No folder yet, or startup failed. Register the commands anyway so the
    // palette explains itself instead of answering "command not found", and
    // retry when the workspace changes — `git init` in an open folder is a
    // completely ordinary thing to do.
    installFallbackCommands(context);
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void tryStart(context)),
    );
  }
}

/** Bring the controller up, or explain why it could not come up. */
async function tryStart(context: vscode.ExtensionContext): Promise<boolean> {
  if (controller) return true;
  const ctx = await findWorkspaceFolder();
  if (!ctx) return false;
  const started = new Controller(context, ctx);
  try {
    await started.start();
    controller = started;
    context.subscriptions.push(started);
    return true;
  } catch (err) {
    // Startup gets partway through before it fails, and what it got through is
    // a tick interval and a file watcher. Leaving those running would be a
    // background process nobody can see, in an extension that reported itself
    // as not running.
    started.dispose();
    // A review tool that breaks the editor it is measuring has failed twice.
    void vscode.window.showErrorMessage(
      `Blindspot could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * The first workspace folder that is inside a git repository, or failing that
 * the first folder at all — reading code needs a folder, not a repository.
 * Checking every folder rather than only the first is what makes a multi-root
 * workspace with the repo in second position work.
 */
async function findWorkspaceFolder(): Promise<WorkspaceContext | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const git = await findGitContext(folder.uri.fsPath);
    if (git) return workspaceFromGit(git);
  }
  return folders.length > 0 ? findWorkspace(folders[0].uri.fsPath) : null;
}

let fallbackCommands: vscode.Disposable[] = [];

function disposeFallbackCommands(): void {
  for (const d of fallbackCommands) d.dispose();
  fallbackCommands = [];
}

function installFallbackCommands(context: vscode.ExtensionContext): void {
  if (fallbackCommands.length > 0) return;
  for (const id of COMMAND_IDS) {
    fallbackCommands.push(
      vscode.commands.registerCommand(id, async () => {
        // The folder may have appeared since activation; try before complaining.
        if (await tryStart(context)) {
          await vscode.commands.executeCommand(id);
          return;
        }
        void vscode.window.showWarningMessage('Blindspot needs an open folder to track reading in.');
      }),
    );
  }
  context.subscriptions.push({ dispose: disposeFallbackCommands });
}

export function deactivate(): Promise<void> | void {
  const pending = controller?.flush();
  controller = undefined;
  disposeFallbackCommands();
  return pending;
}

class Controller implements vscode.Disposable {
  private cfg: BlindspotConfig = DEFAULT_CONFIG;
  private aiRegions: AiRegions = {};
  private tracker!: AttentionTracker;
  private readonly statusBar = new StatusBar();
  private readonly decorations = new Decorations();
  private tree!: BlindspotTree;
  private navigator!: Navigator;
  private commitWatcher!: CommitWatcher;
  private report: DiffReport | null = null;
  /** What the last report measured, for the panel's page. */
  private targets: FileDiff[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private lastRefreshError = '';
  private disposed = false;
  private windowFocused = vscode.window.state.focused;
  /**
   * Everything this controller registers with VS Code. Owned here rather than
   * pushed straight onto `context.subscriptions` so that a controller which
   * fails partway through startup can release it all — in particular its
   * command ids, which the fallback handlers must be able to register again.
   */
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly textCache = new Map<
    string,
    { mtimeMs: number; size: number; lines: string[] }
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ws: WorkspaceContext,
  ) {}

  private get root(): string {
    return this.ws.root;
  }

  async start(): Promise<void> {
    this.cfg = await this.resolveConfig();
    this.aiRegions = await loadAiRegions(this.ws);
    this.navigator = new Navigator(this.root);

    this.tracker = new AttentionTracker(this.ws, this.cfg, this.aiRegions, () =>
      this.scheduleSave(),
    );
    this.tracker.start(await loadState(this.ws));
    this.tree = new BlindspotTree(this.root);

    this.commitWatcher = new CommitWatcher(this.root, () => this.onStaged());
    if (this.ws.git) void this.commitWatcher.start();

    // Honour the setting at startup, not only when it next changes.
    this.decorations.setEnabled(this.setting('decorateUnreviewed', true));

    this.registerCommands();

    // Seed the focus flag here, not at construction: several awaits have
    // passed since then, and a focus change in that gap would otherwise leave
    // the periodic refresh gated on a stale value.
    this.windowFocused = vscode.window.state.focused;
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('blindspot')) void this.reloadConfig();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.reloadConfig()),
      vscode.workspace.onDidSaveTextDocument(() => void this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.decorations.apply(this.report, this.root),
      ),
      vscode.window.onDidChangeWindowState((s) => {
        const regained = s.focused && !this.windowFocused;
        this.windowFocused = s.focused;
        // Whatever happened in a terminal while we were away shows up now,
        // not at the next tick.
        if (regained) void this.refresh();
      }),
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        new EvidenceHover({
          enabled: () => this.setting('explainOnHover', true),
          relativePath: (uri) => this.relativePath(uri),
          report: () => this.report,
          evidence: (file, line) => this.tracker.getEvidence(file, line),
          config: () => this.cfg,
          // A hover request is the editor telling us where the mouse is.
          onPointer: (doc, line) => this.tracker.notePointer(doc, line),
        }),
      ),
    );

    this.scheduleRefresh();
    await this.refresh();
  }

  // ------------------------------------------------------------------ config

  private async resolveConfig(): Promise<BlindspotConfig> {
    // Repo config carries regular expressions that get compiled and run. In a
    // Restricted Mode workspace that file is exactly what the user has not
    // yet trusted, so tracking runs on the defaults until they do.
    const fileCfg = vscode.workspace.isTrusted ? await loadConfig(this.ws) : DEFAULT_CONFIG;
    const s = vscode.workspace.getConfiguration('blindspot');
    return {
      ...fileCfg,
      reviewThresholdPoints: s.get('reviewThresholdPoints', fileCfg.reviewThresholdPoints),
      dwellMs: s.get('dwellMs', fileCfg.dwellMs),
      visibleMsForPoint: s.get('visibleMsForPoint', fileCfg.visibleMsForPoint),
      focusedMsForPoint: s.get('focusedMsForPoint', fileCfg.focusedMsForPoint),
      readingSpeedGuard: s.get('readingSpeedGuard', fileCfg.readingSpeedGuard),
      maxLinesPerSecond: s.get('maxLinesPerSecond', fileCfg.maxLinesPerSecond),
      focalModel: s.get('focalModel', fileCfg.focalModel),
      focalSpanLines: s.get('focalSpanLines', fileCfg.focalSpanLines),
      focalDecayLines: s.get('focalDecayLines', fileCfg.focalDecayLines),
      peripheralFloor: s.get('peripheralFloor', fileCfg.peripheralFloor),
      contentScaling: s.get('contentScaling', fileCfg.contentScaling),
      revisitGapMs: s.get('revisitGapMs', fileCfg.revisitGapMs),
      readAckMs: s.get('readAckMs', fileCfg.readAckMs),
      focusCapMs: s.get('focusCapMs', fileCfg.focusCapMs),
      idleAfterMs: s.get('idleAfterMs', fileCfg.idleAfterMs),
    };
  }

  private async reloadConfig(): Promise<void> {
    this.cfg = await this.resolveConfig();
    this.aiRegions = await loadAiRegions(this.ws);
    this.tracker.updateConfig(this.cfg, this.aiRegions);
    this.decorations.setEnabled(
      vscode.workspace.getConfiguration('blindspot').get('decorateUnreviewed', true),
    );
    await this.refresh();
  }

  private setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('blindspot').get<T>(key, fallback);
  }

  private async writeSetting(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration('blindspot')
      .update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  // ----------------------------------------------------------------- refresh

  private scheduleRefresh(): void {
    const interval = Math.max(1000, this.setting('refreshIntervalMs', 4000));
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => void this.tickRefresh(), interval);
  }

  /**
   * The periodic refresh. Each one is two git processes plus a rebuild of the
   * report. While the window is not focused no evidence is being collected, so
   * unless something is still unsaved there is nothing new to compute — and a
   * review tool should not be what keeps a laptop fan running in the
   * background. Regaining focus triggers a refresh straight away.
   */
  private tickRefresh(): Promise<DiffReport | null> {
    if (!this.windowFocused && !this.tracker.isDirty) return Promise.resolve(this.report);
    return this.refresh();
  }

  async refresh(): Promise<DiffReport | null> {
    if (this.disposed || this.refreshing) return this.report;
    if (!this.setting('enabled', true)) {
      this.showDisabled();
      return null;
    }
    this.refreshing = true;
    try {
      const { report, targets, sources } = await this.measure(this.targetMode());
      this.report = report;
      this.targets = targets;
      this.navigator.sync(this.report);
      this.statusBar.update(this.report, this.setting('showStatusBar', true));
      this.decorations.apply(this.report, this.root);
      this.tree.update(this.report);
      // The page's evidence costs another pass over every target line; only
      // pay for it while someone can see it.
      ReportPanel.active?.update({ report, data: pageData(targets, sources, this.cfg) });
      return this.report;
    } catch (err) {
      console.error('[blindspot] refresh failed', err);
      // Refresh runs every few seconds; say it once per distinct failure, or a
      // bad `blindspot.baseRef` would nag forever — or, worse, never be seen.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastRefreshError) {
        this.lastRefreshError = message;
        void vscode.window.showWarningMessage(`Blindspot: ${message}`);
      }
      return this.report;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * `blindspot.enabled` is off. The last report must not stay on screen as if
   * it were live: the markers clear, and the sidebar says tracking is off
   * rather than showing numbers nobody is updating.
   */
  private showDisabled(): void {
    this.report = null;
    this.targets = [];
    this.navigator.sync(null);
    this.statusBar.update(null, false);
    this.decorations.clear();
    this.tree.update(null, DISABLED_NOTE);
  }

  /**
   * One measurement: the target for a mode, scored under the live config.
   * The target and the sources come back with the report so that the panel's
   * page can be built from the very evidence the report was judged by.
   */
  private async measure(
    mode: TargetMode,
  ): Promise<{ report: DiffReport; targets: FileDiff[]; sources: ReportSources }> {
    const sources = this.makeSources();
    const { targets, baseRef, sinceReview } = await this.collectTargets(mode, sources);
    // Anchor persisted evidence for files that are not open in a tab, or
    // closing a file would silently erase the fact that you read it.
    for (const d of targets) {
      const text = sources.getText(d.file);
      if (text) this.tracker.primeFromText(d.file, text);
    }
    const opts = { mode, sinceReview, activity: this.tracker.activityCounts };
    return { report: buildReport(targets, sources, this.cfg, baseRef, Date.now(), opts), targets, sources };
  }

  /** The panel's input: the last report, and the evidence behind it. */
  private panelView(): PanelView | null {
    if (!this.report) return null;
    return { report: this.report, data: pageData(this.targets, this.makeSources(), this.cfg) };
  }

  /**
   * What the report measures against. The setting wins when it can be
   * honoured; without git only reading can be.
   */
  private targetMode(): TargetMode {
    const s = this.setting<string>('mode', 'auto');
    if (!this.ws.git) return 'reading';
    if (s === 'diff' || s === 'reading') return s;
    return 'diff';
  }

  /**
   * The code target for a mode. One engine, one report; only this differs
   * between reading a codebase and reviewing a change.
   */
  private async collectTargets(
    mode: TargetMode,
    sources: ReportSources,
  ): Promise<{ targets: FileDiff[]; baseRef: string; sinceReview: boolean }> {
    if (mode === 'reading' || !this.ws.git) {
      // Every file you have opened here, whole. Files never opened are not a
      // target: a codebase is not a diff, and "0% of everything" is not a
      // number anyone can act on.
      // Open now or tracked before: a file you just opened is a target even
      // before the first tick has credited anything to it.
      const files = new Set(this.tracker.files());
      for (const doc of vscode.workspace.textDocuments) {
        const rel = this.relativePath(doc.uri);
        if (rel) files.add(rel);
      }
      const targets: FileDiff[] = [];
      for (const file of [...files].sort()) {
        const text = sources.getText(file);
        if (text) targets.push(wholeFileTarget(file, text));
      }
      return { targets, baseRef: 'workspace', sinceReview: false };
    }
    let baseRef = this.setting('baseRef', 'HEAD');
    let sinceReview = false;
    if (this.setting<string>('diffSince', 'lastReview') === 'lastReview') {
      // Everything since the last completed review, the commits in between
      // included. Until a review has been completed that is the base ref.
      const b = this.tracker.reviewBaseline;
      if (b && (await commitExists(this.ws.git, b.commit))) {
        baseRef = b.commit;
        sinceReview = true;
      }
    }
    return { targets: await collectDiff(this.ws.git, { baseRef }), baseRef, sinceReview };
  }

  /**
   * Report inputs. Open documents win over disk so that unsaved edits are
   * measured too — the diff you are about to stage includes them.
   */
  private makeSources(): ReportSources {
    const cache = new Map<string, string[] | undefined>();
    const openDocs = new Map<string, vscode.TextDocument>();
    for (const doc of vscode.workspace.textDocuments) {
      const rel = this.relativePath(doc.uri);
      if (rel) openDocs.set(rel, doc);
    }

    return {
      getText: (file) => {
        if (cache.has(file)) return cache.get(file);
        let lines: string[] | undefined;
        const doc = openDocs.get(file);
        if (doc) {
          lines = docLines(doc);
        } else {
          lines = this.readFileCached(file);
        }
        cache.set(file, lines);
        return lines;
      },
      getEvidence: (file, line) => this.tracker.getEvidence(file, line),
    };
  }

  /**
   * Working-tree text for a file nobody has open, cached across refreshes.
   *
   * The report is rebuilt every few seconds for as long as the editor is open.
   * Re-reading every file of a large diff each time is how a background review
   * tool becomes the reason a laptop fan is running, so a stat (cheap) decides
   * whether the read (not cheap) is needed at all.
   */
  private readFileCached(file: string): string[] | undefined {
    const abs = path.join(this.root, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      this.textCache.delete(file);
      return undefined;
    }
    if (stat.size > MAX_FILE_BYTES) return undefined;

    const hit = this.textCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.lines;

    try {
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      this.textCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
      return lines;
    } catch {
      this.textCache.delete(file);
      return undefined;
    }
  }

  /**
   * Repo-relative path for a document, or null when it is not a file inside
   * this repository. Everything keyed by path — evidence, the report, the
   * decorations — depends on these agreeing.
   */
  private relativePath(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') return null;
    const rel = path.relative(this.root, uri.fsPath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    // Fallback handlers own these ids until we replace them.
    disposeFallbackCommands();
    // A command that throws surfaces as a generic VS Code error naming the
    // command id. Catch it here so the message says what actually failed.
    const push = (id: string, fn: (...args: any[]) => any) =>
      this.subscriptions.push(
        vscode.commands.registerCommand(id, async (...args: any[]) => {
          try {
            return await fn(...args);
          } catch (err) {
            console.error(`[blindspot] ${id} failed`, err);
            void vscode.window.showErrorMessage(
              `Blindspot: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          }
        }),
      );

    push('blindspot.showReport', () => this.showPanel(true));

    push('blindspot.reviewBlindspot', () => this.reviewNext());
    push('blindspot.refresh', () => this.refresh());

    push('blindspot.switchMode', () => this.switchMode());
    push('blindspot.toggleMode', async () => {
      const next: TargetMode = this.targetMode() === 'diff' ? 'reading' : 'diff';
      await this.setMode(next);
    });
    push('blindspot.selectBase', () => this.selectBase());

    // From the sidebar: a file or a range. Not in the palette, so its
    // arguments are always ours; still checked, because a command is public.
    push('blindspot.openHunk', (file: unknown, line: unknown, endLine?: unknown) => {
      if (typeof file !== 'string' || !isRepoRelative(file)) return;
      const start = typeof line === 'number' && Number.isFinite(line) ? line : 1;
      const end = typeof endLine === 'number' && Number.isFinite(endLine) ? endLine : start;
      return this.openAt(file, start, end);
    });

    push('blindspot.toggleDecorations', async () => {
      const next = !this.decorations.isEnabled;
      this.decorations.setEnabled(next);
      if (next) this.decorations.apply(this.report, this.root);
      await this.writeSetting('decorateUnreviewed', next);
    });

    push('blindspot.markFileReviewed', async (node?: unknown) => {
      // From the sidebar's context menu the argument is the tree node; from
      // the palette there is none and the active editor is what is meant.
      const fromTree =
        node && typeof node === 'object' && typeof (node as { file?: unknown }).file === 'string'
          ? (node as { file: string }).file
          : null;
      let rel: string | null = fromTree && isRepoRelative(fromTree) ? fromTree : null;
      let lineCount = rel ? this.makeSources().getText(rel)?.length ?? 0 : 0;
      if (!rel) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage('Blindspot: open a file to mark it reviewed.');
          return;
        }
        rel = this.relativePath(editor.document.uri);
        lineCount = editor.document.lineCount;
        if (!rel) {
          // An untitled buffer, a diff view, an output channel, or a file from
          // another repository. Recording evidence under a path the report will
          // never look up would silently do nothing.
          void vscode.window.showWarningMessage(
            'Blindspot: this file is not a tracked file in this repository.',
          );
          return;
        }
      }
      this.tracker.markReviewed(rel, lineCount);
      await this.refresh();
      void vscode.window.showInformationMessage(`Blindspot: marked ${rel} as reviewed.`);
    });

    push('blindspot.resetSession', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Discard all Blindspot review evidence for this repository?',
        { modal: true },
        'Discard',
      );
      if (answer !== 'Discard') return;
      this.tracker.reset();
      await this.flush();
      await this.refresh();
    });

    push('blindspot.completeReview', () => this.completeReview());

    push('blindspot.installGitHook', async () => {
      if (!this.ws.git) {
        void vscode.window.showWarningMessage(
          'Blindspot: the pre-commit hook needs a git repository.',
        );
        return;
      }
      try {
        const { path: hookPath, action } = await installHook(
          this.ws.git,
          path.join(this.context.extensionUri.fsPath, 'bin', 'blindspot.js'),
        );
        const message =
          action === 'present'
            ? 'Blindspot pre-commit hook is already installed.'
            : `Blindspot pre-commit hook ${action} at ${hookPath}.`;
        void vscode.window.showInformationMessage(message);
      } catch (err) {
        void vscode.window.showErrorMessage(`Blindspot: could not install hook — ${String(err)}`);
      }
    });
  }

  private async showPanel(refreshFirst: boolean): Promise<void> {
    if (refreshFirst) await this.refresh();
    ReportPanel.show(this.context.extensionUri, (m) => void this.onPanelMessage(m), this.panelView());
  }

  // -------------------------------------------------------------------- mode

  private async switchMode(): Promise<void> {
    const current = this.targetMode();
    const mark = (mode: TargetMode) => (mode === current ? '$(check) ' : '');
    const items: Array<vscode.QuickPickItem & { value: TargetMode | 'auto' }> = [
      {
        value: 'diff',
        label: `${mark('diff')}${MODE_LABEL.diff}`,
        description: this.ws.git
          ? 'the lines you changed — since the last completed review, or since the base ref'
          : 'needs a git repository',
      },
      {
        value: 'reading',
        label: `${mark('reading')}${MODE_LABEL.reading}`,
        description: 'every line of every file you open here',
      },
      {
        value: 'auto',
        label: 'Auto',
        description: 'diff in a repository, reading anywhere else',
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'What should Blindspot measure?',
    });
    if (!pick) return;
    if (pick.value === 'auto') {
      await this.writeSetting('mode', 'auto');
      await this.refresh();
      return;
    }
    await this.setMode(pick.value);
  }

  private async setMode(mode: TargetMode): Promise<void> {
    if (mode === 'diff' && !this.ws.git) {
      void vscode.window.showWarningMessage('Blindspot: diff mode needs a git repository.');
      return;
    }
    await this.writeSetting('mode', mode);
    await this.refresh();
    void vscode.window.setStatusBarMessage(`Blindspot: ${MODE_LABEL[mode]} mode`, 3000);
  }

  /** What the diff is measured against: the last completed review, or a ref. */
  private async selectBase(): Promise<void> {
    if (!this.ws.git) {
      void vscode.window.showWarningMessage('Blindspot: choosing a base needs a git repository.');
      return;
    }
    const baseline = this.tracker.reviewBaseline;
    const since = this.setting<string>('diffSince', 'lastReview');
    const baseRef = this.setting('baseRef', 'HEAD');
    const items: Array<vscode.QuickPickItem & { value: 'lastReview' | 'baseRef' | 'other' }> = [
      {
        value: 'lastReview',
        label: `${since === 'lastReview' ? '$(check) ' : ''}Since the last completed review`,
        description: baseline
          ? `${shortRef(baseline.commit)} · commits after it count as unreviewed`
          : `none completed yet, so ${baseRef} until then`,
      },
      {
        value: 'baseRef',
        label: `${since === 'baseRef' ? '$(check) ' : ''}Since ${baseRef}`,
        description: 'the working tree against blindspot.baseRef',
      },
      { value: 'other', label: 'Since another ref…', description: 'a branch, tag or commit' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Measure the diff against…',
    });
    if (!pick) return;
    if (pick.value === 'other') {
      const ref = await vscode.window.showInputBox({
        prompt: 'Git ref to diff against',
        value: baseRef,
        validateInput: (v) => (v.trim() ? null : 'A ref is needed'),
      });
      if (!ref) return;
      await this.writeSetting('baseRef', ref.trim());
      await this.writeSetting('diffSince', 'baseRef');
    } else {
      await this.writeSetting('diffSince', pick.value);
    }
    await this.refresh();
  }

  // ------------------------------------------------------------------- panel

  private async onPanelMessage(m: PanelMessage): Promise<void> {
    // The webview only ever sends back paths this extension put into its HTML,
    // but a message handler that joins an arbitrary string onto the repo root
    // and opens the result is the wrong thing to leave lying around.
    if ('file' in m && !isRepoRelative(m.file)) return;
    switch (m.type) {
      case 'completeReview':
        await this.completeReview();
        return;
      case 'open':
        this.tracker.recordActivity('jumps');
        await this.openAt(m.file, m.line, m.line);
        return;
      case 'reviewNext':
        await this.reviewNext();
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'markReviewed': {
        const text = this.makeSources().getText(m.file);
        this.tracker.markReviewed(m.file, text?.length ?? 0);
        await this.refresh();
        return;
      }
    }
  }

  /** Reveal a range without letting the jump itself count as reading it. */
  private async openAt(file: string, startLine: number, endLine: number): Promise<void> {
    this.tracker.suppressCaretCredit(800);
    try {
      await this.navigator.open(file, startLine, endLine, { viewColumn: vscode.ViewColumn.One });
    } catch (err) {
      await this.couldNotOpen(file, err);
    }
  }

  /**
   * The report is a few seconds old, so the file may have been deleted or
   * renamed since — or it may be something the editor will not open as text.
   * Say which, and bring the report up to date so the next jump is current.
   */
  private async couldNotOpen(file: string, err: unknown): Promise<void> {
    const why = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(`Blindspot: could not open ${file} — ${why}`);
    await this.refresh();
  }

  private async reviewNext(): Promise<void> {
    await this.refresh();
    this.navigator.sync(this.report);
    if (this.navigator.remaining === 0) {
      void vscode.window.showInformationMessage(
        this.report?.mode === 'reading'
          ? 'Blindspot: every line of every opened file has been read.'
          : 'Blindspot: every changed line in this diff has been reviewed.',
      );
      return;
    }
    // Jumping to a blindspot must not be what marks it as read.
    this.tracker.suppressCaretCredit(800);
    const hunk = this.navigator.advance();
    if (!hunk) return;
    try {
      await this.navigator.reveal(hunk);
    } catch (err) {
      await this.couldNotOpen(hunk.file, err);
      return;
    }
    this.tracker.recordActivity('jumps');
    const severe = hunk.risk === 'critical' || hunk.risk === 'high';
    void vscode.window.setStatusBarMessage(
      `${severe ? '⚠️ ' : ''}Blindspot ${this.navigator.progress()} — ${hunk.file}:${hunk.startLine}` +
        `–${hunk.endLine} (${hunk.reason})`,
      6000,
    );
  }

  /**
   * "Reviewed up to here." The baseline moves to HEAD, so the next report
   * measures only what lands after it. Without git there is no commit to
   * anchor to.
   */
  private async completeReview(): Promise<void> {
    if (!this.ws.git) {
      void vscode.window.showWarningMessage('Blindspot: completing a review needs a git repository.');
      return;
    }
    const head = await headCommit(this.ws.git);
    if (!head) {
      void vscode.window.showWarningMessage('Blindspot: no commit to set the review baseline at yet.');
      return;
    }
    const unread = this.report?.unseenLines ?? 0;
    if (unread > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Complete the review with ${unread} unread lines? Everything up to ${head.slice(0, 7)} will count as reviewed.`,
        { modal: true },
        'Complete',
      );
      if (answer !== 'Complete') return;
    }
    this.tracker.setBaseline(head);
    await this.flush();
    await this.refresh();
    void vscode.window.showInformationMessage(
      `Blindspot: review baseline set at ${head.slice(0, 7)}.`,
    );
  }

  // ------------------------------------------------------------------ commit

  private async onStaged(): Promise<void> {
    const live = await this.refresh();
    if (!live) return;
    // A commit is about the diff, whatever the panel is showing. Measuring
    // the diff here regardless of mode is what keeps a reading session from
    // quietly switching the commit-time warning off.
    const report =
      live.mode === 'diff' ? live : this.ws.git ? (await this.measure('diff')).report : null;
    if (!report || report.totalChangedLines === 0) return;

    const threshold = this.setting('warnOnCommitBelow', 70);
    const coverage = pct(report.coverage);
    const severeUnread = report.hunks.some((h) => h.risk === 'critical' || h.risk === 'high');
    if (coverage >= threshold && !severeUnread) return;
    if (!this.commitWatcher.shouldNotify()) return;

    const detail = severeUnread
      ? `${report.unseenLines} unread lines, including high-risk code.`
      : `${report.unseenLines} of ${report.totalChangedLines} changed lines are unread.`;

    const choice = await vscode.window.showWarningMessage(
      `Blindspot ${100 - coverage}% — ${detail}`,
      'Review Blindspot',
      'Show Report',
    );
    if (!choice) return;
    // Either action is about the diff; the panel and the navigator follow the
    // mode, so the mode follows the commit.
    if (live.mode !== 'diff') await this.setMode('diff');
    if (choice === 'Review Blindspot') await this.reviewNext();
    else await this.showPanel(false);
  }

  // ------------------------------------------------------------------- state

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (!this.tracker?.isDirty) return;
    try {
      const sources = this.makeSources();
      const state = this.tracker.snapshot((file) => sources.getText(file));
      await saveState(this.ws, state);
      this.tracker.clearDirty();
    } catch (err) {
      console.error('[blindspot] could not persist state', err);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const d of this.subscriptions.splice(0)) {
      try {
        d.dispose();
      } catch (err) {
        console.error('[blindspot] dispose failed', err);
      }
    }
    // These may already be running when startup fails partway through: the
    // tick interval and the file watcher are started before anything is
    // registered. All of these are idempotent, so disposing them twice costs
    // nothing and orphaning them costs a background process nobody can see.
    this.tracker?.dispose();
    this.commitWatcher?.dispose();
    this.tree?.dispose();
    this.statusBar.dispose();
    this.decorations.dispose();
    void this.flush();
  }
}
