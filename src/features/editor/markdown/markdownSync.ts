// Per-keystroke work control for the Markdown editor.
//
// A transaction only records the newest text (an assignment). The O(n)
// fingerprint, the React state push that re-renders the preview, and the
// save-lifecycle notification are debounced to one pass per quiet window
// — on a multi-megabyte document hashing every keystroke is the whole
// cost of typing.
//
// The save path reads `read()`, which hashes lazily, so an unmount flush
// still persists the newest text even when the debounce never fired.

export interface MarkdownSnapshot {
  source: string;
  fp: string;
}

export interface MarkdownSyncOptions {
  initial: MarkdownSnapshot;
  fingerprint: (source: string) => string;
  /** Runs the debounced work: mirror the text into React state and tell
   *  the save lifecycle something changed. */
  onFlush: (snapshot: MarkdownSnapshot) => void;
  delayMs?: number;
}

export const MARKDOWN_FLUSH_MS = 250;

export class MarkdownSync {
  private text: string;
  private fp: string;
  private fpSource: string;
  private flushedSource: string;
  private timer: number | null = null;

  constructor(private readonly opts: MarkdownSyncOptions) {
    this.text = opts.initial.source;
    this.fp = opts.initial.fp;
    this.fpSource = opts.initial.source;
    this.flushedSource = opts.initial.source;
  }

  /** One editor transaction. Cheap: no hashing, no React update. */
  push(source: string): void {
    this.text = source;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.delayMs ?? MARKDOWN_FLUSH_MS);
  }

  /** Newest text + its fingerprint (hashed only when the text moved). */
  read(): MarkdownSnapshot {
    if (this.text !== this.fpSource) {
      this.fp = this.opts.fingerprint(this.text);
      this.fpSource = this.text;
    }
    return { source: this.text, fp: this.fp };
  }

  /** Run the debounced work now (unmount, or after an explicit save). */
  flush(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    if (this.text === this.flushedSource) return;
    this.flushedSource = this.text;
    this.opts.onFlush(this.read());
  }

  /** Re-baseline for a fresh document (file switch / 409 reload). */
  reset(initial: MarkdownSnapshot): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    this.text = initial.source;
    this.fp = initial.fp;
    this.fpSource = initial.source;
    this.flushedSource = initial.source;
  }

  /** Drop the pending window without reporting it ("Discard"): the text
   *  stays in the editor but must not reach the save path. */
  discard(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    this.flushedSource = this.text;
  }

  /** Unmount: report the newest text so the save lifecycle can flush it. */
  dispose(): void {
    this.flush();
  }
}
