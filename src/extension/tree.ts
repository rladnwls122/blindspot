import * as path from 'node:path';
import * as vscode from 'vscode';
import { MODE_LABEL, baseLabel } from '../core/labels';
import { buildTree, type TreeNode } from '../core/tree';
import type { DiffReport } from '../core/types';

/**
 * The sidebar: every file with something unread, worst first, and under each
 * one the exact ranges. It lives in the Source Control view container, next to
 * the changes it is about, and it is a native tree — theme, keyboard and
 * screen-reader support come for free, which a webview would have to fake.
 *
 * The nodes come from `core/tree.ts`; this class only turns them into
 * `TreeItem`s and wires the clicks.
 */
export class BlindspotTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  static readonly viewId = 'blindspot.files';

  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<TreeNode>;
  private nodes: TreeNode[] = buildTree(null);

  constructor(private readonly root: string) {
    this.view = vscode.window.createTreeView(BlindspotTree.viewId, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
  }

  update(report: DiffReport | null, note?: string): void {
    this.nodes = buildTree(report, note);
    if (report) {
      this.view.description = `${MODE_LABEL[report.mode]} · ${baseLabel(report)}`;
      this.view.badge =
        report.unseenLines > 0
          ? { value: report.unseenLines, tooltip: `${report.unseenLines} unread lines` }
          : undefined;
    } else {
      this.view.description = undefined;
      this.view.badge = undefined;
    }
    this.emitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.nodes;
    return element.kind === 'file' ? element.children : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'summary': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.contextValue = 'summary';
        item.command = { command: 'blindspot.showReport', title: 'Show Review Report' };
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(
          node.label,
          node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.resourceUri = vscode.Uri.file(path.join(this.root, node.file));
        if (node.severe) {
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        } else if (node.unseenLines === 0) {
          item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
        }
        item.contextValue = node.unseenLines > 0 ? 'file' : 'file-read';
        item.command = {
          command: 'blindspot.openHunk',
          title: 'Open',
          arguments: [node.file, node.line, node.line],
        };
        return item;
      }
      case 'hunk': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.iconPath = node.severe
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'))
          : new vscode.ThemeIcon('eye-closed');
        item.contextValue = 'hunk';
        item.command = {
          command: 'blindspot.openHunk',
          title: 'Open',
          arguments: [node.file, node.line, node.endLine],
        };
        return item;
      }
      case 'notice': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'notice';
        return item;
      }
    }
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}
