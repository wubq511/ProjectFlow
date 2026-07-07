/**
 * DotEnvWriter — serial write queue for .env file.
 *
 * All writes are queued and executed one at a time to prevent
 * concurrent write corruption. Each write is atomic (write temp → rename).
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

export interface DotEnvWriterConfig {
  /** Absolute path to .env file */
  filePath: string;
}

export class DotEnvWriter {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: DotEnvWriterConfig) {
    this.filePath = config.filePath;
  }

  /**
   * Set or update an environment variable in .env.
   * Serialized — concurrent calls execute one at a time.
   */
  async setVar(key: string, value: string): Promise<void> {
    // Reject critical system env vars that must never be overwritten
    const PROTECTED_KEYS = new Set(["PATH", "HOME", "USER", "SHELL", "NODE_OPTIONS", "NODE_PATH", "PWD", "LANG", "TERM"]);
    if (PROTECTED_KEYS.has(key)) {
      throw new Error(`不允许写入系统关键环境变量 "${key}"`);
    }
    // Reject values with newlines (would corrupt .env format)
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error("API Key 值不能包含换行符");
    }
    this.queue = this.queue.then(() => this._writeVar(key, value));
    return this.queue;
  }

  /**
   * Delete an environment variable from .env.
   * Serialized — concurrent calls execute one at a time.
   */
  async deleteVar(key: string): Promise<void> {
    this.queue = this.queue.then(() => this._deleteVar(key));
    return this.queue;
  }

  /** Read the current value of a variable from .env. */
  async readVar(key: string): Promise<string | null> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      return parseEnvVar(content, key);
    } catch {
      return null;
    }
  }

  private async _writeVar(key: string, value: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      content = "";
    }

    const lines = content.split("\n");
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;

      const existingKey = trimmed.slice(0, eqIdx).trim();
      if (existingKey === key) {
        lines[i] = `${key}=${value}`;
        found = true;
        break;
      }
    }

    if (!found) {
      // Append at end (ensure newline before if file doesn't end with one)
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.trim() !== "") {
        lines.push("");
      }
      lines.push(`${key}=${value}`);
    }

    await this._atomicWrite(lines.join("\n"));

    // Also update process.env so the change is immediately visible
    process.env[key] = value;
  }

  private async _deleteVar(key: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) return true;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) return true;
      return trimmed.slice(0, eqIdx).trim() !== key;
    });

    await this._atomicWrite(filtered.join("\n"));
    delete process.env[key];
  }

  /** Atomic write: write to temp file in same directory then rename. */
  private async _atomicWrite(content: string): Promise<void> {
    // Place temp file in the same directory as the target to avoid EXDEV errors
    // when tmpdir() and the target are on different filesystems.
    const dir = resolve(this.filePath, "..");
    const tmpPath = resolve(dir, `.env-write-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, this.filePath);
  }

  /** Get the file path (for file watcher). */
  getFilePath(): string {
    return this.filePath;
  }
}

/** Parse a specific variable value from .env content. */
function parseEnvVar(content: string, key: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const existingKey = trimmed.slice(0, eqIdx).trim();
    if (existingKey === key) {
      return trimmed.slice(eqIdx + 1).trim();
    }
  }
  return null;
}
