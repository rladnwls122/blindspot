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

  /**
   * Step to the next hunk without opening it. Kept separate from `reveal` so
   * the caller can say which file failed to open when it does.
   */
  advance(step: 1 | -1 = 1): BlindspotHunk | null {
    const n = this.queue.length;
    if (n === 0) return null;
    // The cursor starts before the first hunk, so a first step forward lands on
    // the worst one and a first step back wraps round to the least bad.
    this.index = this.index < 0 ? (step === 1 ? 0 : n - 1) : (this.index + step + n) % n;
    return this.queue[this.index];
  }

  async next(): Promise<BlindspotHunk | null> {
    const hunk = this.advance();
    if (hunk) await this.reveal(hunk);
    return hunk;
  }

  reveal(hunk: BlindspotHunk): Promise<void> {
    return this.open(hunk.file, hunk.startLine, hunk.endLine, { preserveFocus: false });
  }

  /**
   * Open a repo file with a 1-based line range revealed in the centre of the
   * viewport and the caret parked at its start. Every jump the extension makes
   * — the navigator, the panel's links, the sidebar rows — comes through here,
   * so they cannot drift apart in how they clamp or where they land.
   */
  async open(
    file: string,
    startLine: number,
    endLine: number,
    options: vscode.TextDocumentShowOptions = {},
  ): Promise<void> {
    const uri = vscode.Uri.file(path.join(this.root, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, options);

    const lastLine = Math.max(0, doc.lineCount - 1);
    const start = Math.min(Math.max(0, startLine - 1), lastLine);
    const end = Math.min(Math.max(0, endLine - 1), lastLine);
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
