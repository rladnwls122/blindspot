import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import type { DiffReport, FileReport } from '../src/core/types';

/**
 * The provider is a thin adapter from `buildTree` to `TreeItem`s. What is
 * worth testing is the part that touches the editor: it must not ask VS Code
 * to redraw the tree every few seconds when the report has not changed, and
 * a row must carry the command and argument a click needs.
 */

let fired = 0;

class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: number,
  ) {}
}
class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}
class ThemeColor {
  constructor(public id: string) {}
}
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {
    fired++;
  }
  dispose() {}
}

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return {
      TreeItem,
      ThemeIcon,
      ThemeColor,
      EventEmitter,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    };
  }
  return load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SidebarProvider } = require('../src/extension/sidebar');

function file(overrides: Partial<FileReport> = {}): FileReport {
  return {
    file: 'src/a.ts',
    changedLines: 10,
    reviewedLines: 4,
    unseenLines: 6,
    coverage: 0.4,
    weightedCoverage: 0.4,
    risk: 'medium',
    blindspotRisk: 'medium',
    aiLines: 0,
    aiReviewedLines: 0,
    hunks: [{ file: 'src/a.ts', startLine: 7, endLine: 9, lineCount: 3, risk: 'medium', reason: '', aiRatio: 0 }],
    ...overrides,
  };
}

function report(files: FileReport[], generatedAt = 0): DiffReport {
  const total = files.reduce((n, f) => n + f.changedLines, 0);
  const reviewed = files.reduce((n, f) => n + f.reviewedLines, 0);
  return {
    baseRef: 'HEAD',
    generatedAt,
    totalChangedLines: total,
    reviewedLines: reviewed,
    unseenLines: total - reviewed,
    coverage: total ? reviewed / total : 1,
    blindspot: total ? 1 - reviewed / total : 0,
    score: {
      coverage: 0,
      critical: 0,
      newCode: 0,
      ai: 0,
      score: 0,
      measured: { coverage: true, critical: false, newCode: false, ai: false },
    },
    files,
    hunks: files.flatMap((f) => f.hunks),
    worstFile: files[0] ?? null,
  };
}

describe('sidebar provider', () => {
  beforeEach(() => {
    fired = 0;
  });

  test('an unchanged report does not make the tree redraw', () => {
    const provider = new SidebarProvider();
    provider.update(report([file()]));
    assert.equal(fired, 1);
    provider.update(report([file()], 4000));
    assert.equal(fired, 1, 'same tree, no event');
    provider.update(report([file({ reviewedLines: 5, unseenLines: 5, coverage: 0.5 })]));
    assert.equal(fired, 2, 'a real change fires');
    provider.update(null);
    assert.equal(fired, 3, 'clearing the tree fires');
    assert.deepEqual(provider.getChildren(), []);
  });

  test('a row opens its file at the first unread line', () => {
    const provider = new SidebarProvider();
    provider.update(report([file()]));
    const [group] = provider.getChildren();
    const groupItem = provider.getTreeItem(group);
    assert.equal(groupItem.collapsibleState, 2, 'groups start expanded');
    assert.equal(groupItem.description, '60% unread');

    const [row] = provider.getChildren(group);
    const item = provider.getTreeItem(row);
    assert.equal(item.label, 'src/a.ts');
    assert.equal(item.command?.command, 'blindspot.revealFile');
    assert.deepEqual(item.command?.arguments, [row]);
    assert.equal(row.firstUnreadLine, 7);
    assert.equal(provider.getChildren(row).length, 0, 'files have no children');
  });

  test('the icon says what the row means', () => {
    const provider = new SidebarProvider();
    const severe = file({ file: 'auth.ts', blindspotRisk: 'critical' });
    const done = file({ file: 'done.ts', reviewedLines: 10, unseenLines: 0, coverage: 1, hunks: [] });
    provider.update(report([severe, file(), done]));
    const [group] = provider.getChildren();
    const icons = provider.getChildren(group).map((n: unknown) => (provider.getTreeItem(n).iconPath as ThemeIcon).id);
    assert.deepEqual(icons, ['warning', 'eye-closed', 'check']);
  });
});
