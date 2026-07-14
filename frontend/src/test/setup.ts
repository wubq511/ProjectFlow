import { beforeEach } from "vitest";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function ensureStorage(): void {
  if (typeof window !== "undefined" && !window.localStorage) {
    Object.defineProperty(window, "localStorage", {
      value: new MockStorage(),
      writable: true,
      configurable: true,
    });
  }
  if (typeof window !== "undefined" && !window.sessionStorage) {
    Object.defineProperty(window, "sessionStorage", {
      value: new MockStorage(),
      writable: true,
      configurable: true,
    });
  }
}

ensureStorage();

beforeEach(() => {
  ensureStorage();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
