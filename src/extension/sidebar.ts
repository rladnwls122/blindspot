import * as vscode from 'vscode';
import { buildTree, type GroupNode, type TreeNode } from '../core/tree';
import type { DiffReport } from '../core/types';

export type { FileNode, GroupNode, TreeNode } from '../core/tree';

/**
 * The Activity Bar view. A native TreeView, not a webview: theme, keyboard
 * and screen-reader support come for free, and the dashboard button in its
 * title is a real VS Code button rather than a picture of one.
 *
 * The tree itself is built by `buildTree` in core; this class only turns
 * nodes into `TreeItem`s.
 */
export class SidebarProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  static readonly viewId = 'blindspot.sidebar';

  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private groups: GroupNode[] = [];

  update(diff: DiffReport | null, scope: DiffReport | null = null): void {
    this.groups = buildTree(diff, scope);
    this.changed.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.groups;
    return node.kind === 'group' ? node.children : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      item.description = node.description;
      item.contextValue = `blindspot.group.${node.id}`;
      item.iconPath = new vscode.ThemeIcon(node.id === 'diff' ? 'git-compare' : 'book');
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = 'blindspot.file';
    item.iconPath = node.severe
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'))
      : new vscode.ThemeIcon(node.firstUnreadLine === null ? 'check' : 'eye-closed');
    item.command = {
      command: 'blindspot.revealFile',
      title: 'Open at first unread line',
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
