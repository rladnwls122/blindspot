import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_CONFIG, type BlindspotConfig } from '../core/config';
import { buildReport, pageData, wholeFileTarget, type ReportSources } from '../core/coverage';
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
import { findWorkspace, workspaceFromGit, type WorkspaceContext } from './workspace';

const SAVE_DEBOUNCE_MS = 5000;
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
  'blindspot.toggleDecorations',
  'blindspot.markFileReviewed',
  'blindspot.resetSession',
  'blindspot.installGitHook',
  'blindspot.completeReview',
  'blindspot.selectTarget',
] as const;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!(await tryStart(context))) {
    // No repo yet, or startup failed. Register the commands anyway so the
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
        // The repo may have appeared since activation; try before complaining.
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

    this.commitWatcher = new CommitWatcher(this.root, () => this.onStaged());
    if (this.ws.git) void this.commitWatcher.start();

    // Honour the setting at startup, not only when it next changes.
    this.decorations.setEnabled(this.setting('decorateUnreviewed', true));

    this.registerCommands();

    this.context.subscriptions.push(
      this.statusBar,
      this.decorations,
      this.tracker,
      this.commitWatcher,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('blindspot')) void this.reloadConfig();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.reloadConfig()),
      vscode.workspace.onDidSaveTextDocument(() => void this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.decorations.apply(this.report, this.root),
      ),
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        new EvidenceHover({
          enabled: () => this.setting('explainOnHover', true),
          relativePath: (uri) => this.relativePath(uri),
          report: () => this.report,
          evidence: (file, line) => this.tracker.getEvidence(file, line),
          config: () => this.cfg,
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

  // ----------------------------------------------------------------- refresh

  private scheduleRefresh(): void {
    const interval = Math.max(1000, this.setting('refreshIntervalMs', 4000));
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => void this.refresh(), interval);
  }

  async refresh(): Promise<DiffReport | null> {
    if (this.disposed || this.refreshing) return this.report;
    if (!this.setting('enabled', true)) {
      this.statusBar.update(null, false);
      return null;
    }
    this.refreshing = true;
    try {
      const mode = this.targetMode();
      const sources = this.makeSources();
      const { targets, baseRef } = await this.collectTargets(mode, sources);
      // Anchor persisted evidence for files that are not open in a tab, or
      // closing a file would silently erase the fact that you read it.
      for (const d of targets) {
        const text = sources.getText(d.file);
        if (text) this.tracker.primeFromText(d.file, text);
      }
      this.report = buildReport(targets, sources, this.cfg, baseRef, Date.now(), {
        mode,
        activity: this.tracker.activityCounts,
      });
      this.targets = targets;
      this.navigator.sync(this.report);
      this.statusBar.update(this.report, this.setting('showStatusBar', true));
      this.decorations.apply(this.report, this.root);
      // The page's evidence costs another pass over every target line; only
      // pay for it while someone can see it.
      ReportPanel.active?.update({
        report: this.report,
        data: pageData(targets, sources, this.cfg),
      });
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
   * What the report measures against. The setting wins when it can be
   * honoured; without git only reading can be.
   */
  private targetMode(): TargetMode {
    const s = this.setting<string>('target', 'auto');
    if (!this.ws.git) return 'reading';
    if (s === 'diff' || s === 'unreviewed' || s === 'reading') return s;
    return 'unreviewed';
  }

  /**
   * The code target for a mode. One engine, one report; only this differs
   * between reading a codebase and reviewing a change.
   */
  private async collectTargets(
    mode: TargetMode,
    sources: ReportSources,
  ): Promise<{ targets: FileDiff[]; baseRef: string }> {
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
      return { targets, baseRef: 'workspace' };
    }
    let baseRef = this.setting('baseRef', 'HEAD');
    if (mode === 'unreviewed') {
      // Everything since the last completed review, the commits in between
      // included. Until a review has been completed that is HEAD.
      const b = this.tracker.reviewBaseline;
      if (b && (await commitExists(this.ws.git, b.commit))) baseRef = b.commit;
    }
    return { targets: await collectDiff(this.ws.git, { baseRef }), baseRef };
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
    const push = (id: string, fn: (...args: any[]) => any) =>
      this.context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    push('blindspot.showReport', async () => {
      await this.refresh();
      ReportPanel.show(this.context.extensionUri, (m) => void this.onPanelMessage(m), this.panelView());
    });

    push('blindspot.reviewBlindspot', () => this.reviewNext());

    push('blindspot.toggleDecorations', async () => {
      const next = !this.decorations.isEnabled;
      this.decorations.setEnabled(next);
      if (next) this.decorations.apply(this.report, this.root);
      await vscode.workspace
        .getConfiguration('blindspot')
        .update('decorateUnreviewed', next, vscode.ConfigurationTarget.Workspace);
    });

    push('blindspot.markFileReviewed', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Blindspot: open a file to mark it reviewed.');
        return;
      }
      const rel = this.relativePath(editor.document.uri);
      if (!rel) {
        // An untitled buffer, a diff view, an output channel, or a file from
        // another repository. Recording evidence under a path the report will
        // never look up would silently do nothing.
        void vscode.window.showWarningMessage(
          'Blindspot: this file is not a tracked file in this repository.',
        );
        return;
      }
      this.tracker.markReviewed(rel, editor.document.lineCount);
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

    push('blindspot.selectTarget', async () => {
      const items: Array<vscode.QuickPickItem & { value: string }> = [
        { value: 'auto', label: 'Auto', description: 'unreviewed changes in a repository, reading elsewhere' },
        { value: 'unreviewed', label: 'Unreviewed changes', description: 'everything since the last completed review' },
        { value: 'diff', label: 'Diff', description: 'working tree against blindspot.baseRef' },
        { value: 'reading', label: 'Reading', description: 'every line of every file you have opened' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'What should Blindspot measure?',
      });
      if (!pick) return;
      await vscode.workspace
        .getConfiguration('blindspot')
        .update('target', pick.value, vscode.ConfigurationTarget.Workspace);
      await this.refresh();
    });

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

  private async onPanelMessage(m: PanelMessage): Promise<void> {
    // The webview only ever sends back paths this extension put into its HTML,
    // but a message handler that joins an arbitrary string onto the repo root
    // and opens the result is the wrong thing to leave lying around.
    if ('file' in m && !isRepoRelative(m.file)) return;
    switch (m.type) {
      case 'completeReview':
        await this.completeReview();
        return;
      case 'open': {
        this.tracker.recordActivity('jumps');
        const uri = vscode.Uri.file(path.join(this.root, m.file));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const line = Math.min(Math.max(0, m.line - 1), Math.max(0, doc.lineCount - 1));
        this.tracker.suppressCaretCredit();
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        return;
      }
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

  private async reviewNext(): Promise<void> {
    await this.refresh();
    this.navigator.sync(this.report);
    if (this.navigator.remaining === 0) {
      void vscode.window.showInformationMessage(
        'Blindspot: every changed line in this diff has been reviewed.',
      );
      return;
    }
    // Jumping to a blindspot must not be what marks it as read.
    this.tracker.suppressCaretCredit(800);
    const hunk = await this.navigator.next();
    if (!hunk) return;
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
    const report = await this.refresh();
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
    if (choice === 'Review Blindspot') await this.reviewNext();
    else if (choice === 'Show Report') {
      ReportPanel.show(this.context.extensionUri, (m) => void this.onPanelMessage(m), this.panelView());
    }
  }

  /** The panel's input: the last report, and the evidence behind it. */
  private panelView(): PanelView | null {
    if (!this.report) return null;
    return { report: this.report, data: pageData(this.targets, this.makeSources(), this.cfg) };
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
    // Normally VS Code disposes these through context.subscriptions. It cannot
    // when startup failed before they were registered there, and by then the
    // tick interval and the file watcher are already running. All four are
    // idempotent, so disposing them twice costs nothing and orphaning them
    // costs a background process nobody can see.
    this.tracker?.dispose();
    this.commitWatcher?.dispose();
    this.statusBar.dispose();
    this.decorations.dispose();
    void this.flush();
  }
}
