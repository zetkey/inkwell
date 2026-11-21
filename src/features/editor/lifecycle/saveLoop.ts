// Framework-free core of the editor autosave lifecycle: the debounce
// timer, the coalescing save loop, 409 reload and discard/reset. The
// React adapter is `useSaveLifecycle`; keeping the loop out of React is
// what lets the behaviour (unmount flush, mid-flight edits, 409 retry)
// be tested with fake timers and a fake transport.
//
// Editors pass a `live` bag of closures; the hook refreshes that bag on
// every render so the loop always sees the latest transport/snapshot
// reader without being re-created.

import { ApiError } from "@/lib/api/client";
import { errorMessage } from "@/lib/errors";
import type { EditorSaveStatus, SaveLifecycleTransport } from "./types";

// 30s autosave debounce. Both editors used this exact value
// independently — keeping it in one place is the whole point of this
// extraction.
const SAVE_DEBOUNCE_MS = 30_000;

/**
 * Snapshot returned by `getLatest()`. The fingerprint is a cheap
 * content hash the editor computes; the blob is whatever the
 * transport's `save` accepts.
 */
export interface SaveSnapshot<TBlob> {
  fp: string;
  blob: TBlob;
}

export interface SaveLoopLive<TBlob, TLoaded> {
  /** Read-only sessions (share-token reads) skip the entire save path. */
  readOnly: boolean;
  transport: SaveLifecycleTransport<TBlob, TLoaded>;
  /** Returns the latest in-memory snapshot to persist, or null if there
   *  is nothing pending. Called on every save attempt; the editor
   *  closes over its mutable snapshot ref. */
  getLatest: () => SaveSnapshot<TBlob> | null;
  /** Fired after each successful save with the snapshot that was
   *  written. Editors use this to schedule a thumbnail upload. */
  onSaved?: (saved: SaveSnapshot<TBlob>) => void;
  /** Fired after a 409 → reload succeeded. The loop updates its own
   *  internal version before invoking this. */
  onReload?: (loaded: TLoaded, freshVersion: number) => void;
}

export interface SaveLoopOptions<TBlob, TLoaded> {
  initialVersion: number;
  initialFingerprint: string;
  debounceMs?: number;
  /** Mirrors every status transition to the host (React state). */
  onStatus: (status: EditorSaveStatus, error: string | null) => void;
  live: SaveLoopLive<TBlob, TLoaded>;
}

export class SaveLoop<TBlob, TLoaded extends { meta: { version: number } }> {
  live: SaveLoopLive<TBlob, TLoaded>;

  private readonly onStatus: (status: EditorSaveStatus, error: string | null) => void;
  private readonly debounceMs: number;

  private version: number;
  private savedFp: string;

  private inflight = false;
  private promise: Promise<boolean> | null = null;
  private timer: number | null = null;
  private pending = false;

  // After a 409 reload the canvas still holds the stale local scene;
  // writing it back would clobber the other tab. Stays set until the
  // host resets (or remounts the editor).
  private halted = false;
  private disposed = false;

  private status: EditorSaveStatus = "saved";

  constructor(opts: SaveLoopOptions<TBlob, TLoaded>) {
    this.live = opts.live;
    this.onStatus = opts.onStatus;
    this.debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.version = opts.initialVersion;
    this.savedFp = opts.initialFingerprint;
  }

  private setStatus(status: EditorSaveStatus, error: string | null): void {
    this.status = status;
    this.onStatus(status, error);
  }

  /** Editor pushed a fresh snapshot: dedup against the last persisted
   *  content and schedule the debounced save when it differs. */
  notifyChange(): void {
    if (this.live.readOnly || this.disposed) return;
    const snapshot = this.live.getLatest();
    if (!snapshot) return;

    // Cheap dedup (cursor / selection / zoom ticks fire onChange too).
    if (snapshot.fp === this.savedFp) {
      if (!this.inflight) {
        this.cancelPending();
        this.setStatus("saved", null);
      }
      return;
    }

    this.setStatus(this.status === "saving" ? "saving" : "dirty", null);
    this.schedule();
  }

  /** Cancel the debounce and force-save the current latest. Resolves
   *  `true` on success (or read-only no-op), `false` on error/409. */
  saveNow(): Promise<boolean> {
    if (this.live.readOnly) return Promise.resolve(true);
    this.cancelPending();
    return this.saveLatest();
  }

  /** Discard pending local work (the leave dialog's Discard branch).
   *  Drops the debounced call so the unmount flush can't resurrect it. */
  discard(): void {
    this.cancelPending();
    if (!this.inflight) this.setStatus("saved", null);
  }

  /** Reset the baseline when the host loads a different file (or the
   *  same file at a fresh version after a 409 reload). */
  reset(version: number, fingerprint: string): void {
    this.version = version;
    this.savedFp = fingerprint;
    this.promise = null;
    this.halted = false;
    this.cancelPending();
    this.setStatus("saved", null);
  }

  /** beforeunload / tab-hidden: run the pending save immediately. */
  flush(): void {
    if (!this.pending) return;
    this.cancelPending();
    void this.saveLatest();
  }

  /** Unmount: run the pending save (last chance for the edits the user
   *  navigated away from), then stop taking further laps. */
  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  /** Re-arm after `dispose()`. StrictMode double-invokes effects in dev
   *  (cleanup then mount again) on the same loop instance. */
  attach(): void {
    this.disposed = false;
  }

  private schedule(): void {
    this.pending = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      void this.saveLatest();
    }, this.debounceMs);
  }

  private cancelPending(): void {
    this.pending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private saveLatest(): Promise<boolean> {
    if (this.live.readOnly) return Promise.resolve(true);
    if (this.halted) return Promise.resolve(false);

    // Coalesce: a save is already in flight — mark that we want another
    // lap; the running loop re-reads `getLatest()` afterwards.
    if (this.inflight) return this.promise ?? Promise.resolve(false);

    const task = (async (): Promise<boolean> => {
      this.inflight = true;
      try {
        while (true) {
          const snapshot = this.live.getLatest();
          if (!snapshot || snapshot.fp === this.savedFp) {
            this.setStatus("saved", null);
            return true;
          }

          this.setStatus("saving", null);

          try {
            const res = await this.live.transport.save(this.version, snapshot.blob);
            this.version = res.version;
            this.savedFp = snapshot.fp;
            try {
              this.live.onSaved?.(snapshot);
            } catch {
              // Don't let an onSaved error cancel further save laps.
            }
          } catch (e) {
            if (e instanceof ApiError && e.status === 409 && this.live.transport.reload) {
              try {
                const fresh = await this.live.transport.reload();
                const freshVersion = fresh.meta.version;
                this.version = freshVersion;
                this.halted = true;
                this.cancelPending();
                this.live.onReload?.(fresh, freshVersion);
                this.setStatus("error", "Refreshed: another tab saved a newer version.");
              } catch {
                this.setStatus("error", "Conflict; reload failed.");
              }
            } else {
              this.setStatus("error", errorMessage(e, "save failed"));
            }
            return false;
          }

          // Lap done. Exit when nothing newer arrived meanwhile, when the
          // editor unmounted (its pending work is already persisted), or
          // otherwise loop and persist the newer snapshot too.
          const next = this.live.getLatest();
          if (!next || next.fp === this.savedFp || this.disposed) {
            this.setStatus("saved", null);
            return true;
          }
        }
      } finally {
        this.inflight = false;
        this.promise = null;
      }
    })();

    this.promise = task;
    return task;
  }
}
