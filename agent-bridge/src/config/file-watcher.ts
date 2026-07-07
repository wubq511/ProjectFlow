/**
 * FileWatcher — watches files for changes with debounce.
 *
 * Used to auto-reload model-configs.json and .env when edited externally.
 * Falls back gracefully if fs.watch fails (e.g., NFS, Docker volume).
 */

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

export interface FileWatcherConfig {
  /** File paths to watch */
  paths: string[];
  /** Callback on file change (after debounce) */
  onChange: (path: string) => void | Promise<void>;
  /** Debounce interval in ms (default 500) */
  debounceMs?: number;
}

export class FileWatcher {
  private readonly paths: string[];
  private readonly onChange: (path: string) => void | Promise<void>;
  private readonly debounceMs: number;
  private watchers: FSWatcher[] = [];
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;

  constructor(config: FileWatcherConfig) {
    this.paths = config.paths.map((p) => resolve(p));
    this.onChange = config.onChange;
    this.debounceMs = config.debounceMs ?? 500;
  }

  /** Start watching. Logs warning if fs.watch fails. */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const path of this.paths) {
      try {
        const watcher = watch(path, (eventType) => {
          // Handle both 'change' and 'rename' (atomic-save editors emit 'rename' on macOS)
          if (eventType === "change" || eventType === "rename") {
            this._debounce(path);
          }
        });
        watcher.on("error", (err) => {
          console.warn(`[agent-bridge] file watch error for ${path}:`, err.message);
        });
        this.watchers.push(watcher);
      } catch (err) {
        console.warn(
          `[agent-bridge] 无法监听文件 ${path}，降级为仅手动 reload。` +
          `错误: ${(err as Error).message}`,
        );
      }
    }

    if (this.watchers.length > 0) {
      console.log(`[agent-bridge] 文件监听已启动: ${this.paths.join(", ")}`);
    }
  }

  /** Stop watching. */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.running = false;
  }

  private _debounce(path: string): void {
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);

    this.timers.set(path, setTimeout(async () => {
      this.timers.delete(path);
      try {
        await this.onChange(path);
      } catch (err) {
        console.error(`[agent-bridge] file reload error for ${path}:`, err instanceof Error ? err.message : String(err));
      }
    }, this.debounceMs));
  }
}
