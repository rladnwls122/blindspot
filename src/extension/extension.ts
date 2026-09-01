import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_CONFIG, type BlindspotConfig } from '../core/config';
import { buildReport, type ReportSources } from '../core/coverage';
import { pct } from '../core/score';
import type { DiffReport } from '../core/types';
import type { AiRegions } from '../core/store';
import { CommitWatcher } from './commitwatch';
import { Decorations } from './decorations';
import { collectDiff, findGitContext, type GitContext } from './git';
import { Navigator } from './navigator';
import { ReportPanel, type PanelMessage } from './panel';
import { StatusBar } from './statusbar';
import { installHook, loadAiRegions, loadConfig, loadState, saveState } from './storage';
import { AttentionTracker, docLines } from './tracker';

const SAVE_DEBOUNCE_MS = 5000;
/** Above this a file is not read for the report; a diff in it is not reviewable text. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

let controller: Controller | undefined;

/** Every command the extension contributes, in package.json order. */
const COMMAND_IDS = [
  'blindspot.showReport',
  'blindspot.reviewBlindspot',
  'blindspot.toggleDecorations',
  'blindspot.markFileReviewed',
  'blindspot.resetSession',
  'blindspot.installGitHook',
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
  const ctx = await findRepo();
  if (!ctx) return false;
  try {
    const started = new Controller(context, ctx);
    await started.start();
    controller = started;
    context.subscriptions.push(started);
    return true;
  } catch (err) {
    // A review tool that breaks the editor it is measuring has failed twice.
    void vscode.window.showErrorMessage(
      `Blindspot could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * First workspace folder that is inside a git repository. Checking every folder
 * rather than only the first is what makes a multi-root workspace with the repo
 * in second position work at all.
 */
async function findRepo(): Promise<GitContext | null> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const ctx = await findGitContext(folder.uri.fsPath);
    if (ctx) return ctx;
  }
  return null;
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
        void vscode.window.showWarningMessage(
          vscode.workspace.workspaceFolders?.length
            ? 'Blindspot needs a git repository — this workspace is not inside one. Review coverage is measured against a diff.'
            : 'Blindspot needs an open folder inside a git repository.',
        );
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
  private refreshTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private disposed = false;
  private readonly textCache = new Map<
    string,
    { mtimeMs: number; size: number; lines: string[] }
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitContext,
  ) {}

  async start(): Promise<void> {
    this.cfg = await this.resolveConfig();
    this.aiRegions = await loadAiRegions(this.git);
    this.navigator = new Navigator(this.git.root);

    this.tracker = new AttentionTracker(this.git, this.cfg, this.aiRegions, () =>
      this.scheduleSave(),
    );
    this.tracker.start(await loadState(this.git));

    this.commitWatcher = new CommitWatcher(this.git.root, () => this.onStaged());
    void this.commitWatcher.start();

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
      vscode.workspace.onDidSaveTextDocument(() => void this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.decorations.apply(this.report, this.git.root),
      ),
    );

    this.scheduleRefresh();
    await this.refresh();
  }

  // ------------------------------------------------------------------ config

  private async resolveConfig(): Promise<BlindspotConfig> {
    const fileCfg = await loadConfig(this.git);
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
    };
  }

  private async reloadConfig(): Promise<void> {
    this.cfg = await this.resolveConfig();
    this.aiRegions = await loadAiRegions(this.git);
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
      const baseRef = this.setting('baseRef', 'HEAD');
      const diffs = await collectDiff(this.git, { baseRef });
      const sources = this.makeSources();
      // Anchor persisted evidence for files that are not open in a tab, or
      // closing a file would silently erase the fact that you read it.
      for (const d of diffs) {
        const text = sources.getText(d.file);
        if (text) this.tracker.primeFromText(d.file, text);
      }
      this.report = buildReport(diffs, sources, this.cfg, baseRef);
      this.navigator.sync(this.report);
      this.statusBar.update(this.report, this.setting('showStatusBar', true));
      this.decorations.apply(this.report, this.git.root);
      ReportPanel.active?.update(this.report);
      return this.report;
    } catch (err) {
      console.error('[blindspot] refresh failed', err);
      return this.report;
    } finally {
      this.refreshing = false;
    }
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
    const abs = path.join(this.git.root, file);
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
    const rel = path.relative(this.git.root, uri.fsPath).split(path.sep).join('/');
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
      const report = (await this.refresh()) ?? this.report;
      ReportPanel.show(this.context.extensionUri, (m) => void this.onPanelMessage(m), report);
    });

    push('blindspot.reviewBlindspot', () => this.reviewNext());

    push('blindspot.toggleDecorations', async () => {
      const next = !this.decorations.isEnabled;
      this.decorations.setEnabled(next);
      if (next) this.decorations.apply(this.report, this.git.root);
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

    push('blindspot.installGitHook', async () => {
      try {
        const { path: hookPath, action } = await installHook(
          this.git,
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
    switch (m.type) {
      case 'open': {
        const uri = vscode.Uri.file(path.join(this.git.root, m.file));
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
    const severe = hunk.risk === 'critical' || hunk.risk === 'high';
    void vscode.window.setStatusBarMessage(
      `${severe ? '⚠️ ' : ''}Blindspot ${this.navigator.progress()} — ${hunk.file}:${hunk.startLine}` +
        `–${hunk.endLine} (${hunk.reason})`,
      6000,
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
      ReportPanel.show(this.context.extensionUri, (m) => void this.onPanelMessage(m), this.report);
    }
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
      await saveState(this.git, state);
      this.tracker.clearDirty();
    } catch (err) {
      console.error('[blindspot] could not persist state', err);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    void this.flush();
  }
}
