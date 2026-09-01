import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlindspotHunk, DiffReport } from '../core/types';

/**
 * "Review Blindspot": walk the unread hunks, worst first.
 *
 * The cursor is parked one line above the hunk and the range is revealed in
 * the centre of the viewport, so the code arrives with context around it
 * rather than pinned to the top edge where it is easy to skim past.
 */
export class Navigator {
  private queue: BlindspotHunk[] = [];
  private index = -1;
  private signature = '';

  constructor(private readonly root: string) {}

  /** Rebuild the queue when the report changes, keeping our place if we can. */
  sync(report: DiffReport | null): void {
    const hunks = report?.hunks ?? [];
    const signature = hunks.map((h) => `${h.file}:${h.startLine}-${h.endLine}`).join('|');
    if (signature === this.signature) return;

    const currentKey = this.index >= 0 ? key(this.queue[this.index]) : null;
    this.queue = hunks;
    this.signature = signature;
    this.index = currentKey ? hunks.findIndex((h) => key(h) === currentKey) : -1;
  }

  get remaining(): number {
    return this.queue.length;
  }

  async next(): Promise<BlindspotHunk | null> {
    if (this.queue.length === 0) return null;
    this.index = (this.index + 1) % this.queue.length;
    const hunk = this.queue[this.index];
    await this.reveal(hunk);
    return hunk;
  }

  async reveal(hunk: BlindspotHunk): Promise<void> {
    const uri = vscode.Uri.file(path.join(this.root, hunk.file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });

    const lastLine = Math.max(0, doc.lineCount - 1);
    const start = Math.min(Math.max(0, hunk.startLine - 1), lastLine);
    const end = Math.min(Math.max(0, hunk.endLine - 1), lastLine);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);

    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  }

  /** Where we are, for the notification text. */
  progress(): string {
    if (this.queue.length === 0) return '';
    return `${this.index + 1} of ${this.queue.length}`;
  }

  reset(): void {
    this.index = -1;
  }
}

function key(h: BlindspotHunk | undefined): string {
  return h ? `${h.file}:${h.startLine}` : '';
}
