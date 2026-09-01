import * as vscode from 'vscode';

/**
 * Notices when a commit is about to happen.
 *
 * VS Code has no "before commit" hook, so we lean on the built-in Git
 * extension's model: the moment the index gains staged changes, a commit is
 * being prepared. That is the point where telling someone what they have not
 * read is still useful, and where interrupting them is still cheap.
 *
 * Everything here is defensive — the Git extension's API is not typed for
 * third parties and may be disabled entirely, in which case the git hook
 * installed by `blindspot.installGitHook` remains the backstop.
 */
export class CommitWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastStagedCount = 0;
  private lastNotifiedAt = 0;

  constructor(
    private readonly root: string,
    private readonly onStaged: () => void,
  ) {}

  async start(): Promise<boolean> {
    try {
      const ext = vscode.extensions.getExtension('vscode.git');
      if (!ext) return false;
      const api = (await ext.activate())?.getAPI?.(1);
      if (!api) return false;

      const attach = () => {
        const repo = findRepo(api, this.root);
        if (!repo?.state?.onDidChange) return;
        this.disposables.push(
          repo.state.onDidChange(() => {
            const staged = repo.state.indexChanges?.length ?? 0;
            const crossedIntoStaging = staged > 0 && this.lastStagedCount === 0;
            this.lastStagedCount = staged;
            if (crossedIntoStaging) this.onStaged();
          }),
        );
      };

      attach();
      if (api.onDidOpenRepository) {
        this.disposables.push(api.onDidOpenRepository(() => attach()));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Rate-limit the nudge: at most once a minute, and never twice in a row. */
  shouldNotify(now = Date.now()): boolean {
    if (now - this.lastNotifiedAt < 60_000) return false;
    this.lastNotifiedAt = now;
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function findRepo(api: any, root: string): any {
  const repos = api.repositories ?? [];
  return (
    repos.find((r: any) => normalize(r?.rootUri?.fsPath ?? '') === normalize(root)) ?? repos[0] ?? null
  );
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
