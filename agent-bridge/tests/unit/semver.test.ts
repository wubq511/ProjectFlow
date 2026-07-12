/**
 * Semver tests — version parsing, range checking, compatibility.
 */

import { describe, it, expect } from "vitest";
import {
  parseSemVer,
  compareVersions,
  satisfiesRange,
  satisfiesCompatibility,
  checkManifestCompatibility,
  checkPromptCompatibility,
} from "../../src/skills/semver.js";

describe("Semver", () => {
  describe("parseSemVer", () => {
    it("parses valid semver", () => {
      const v = parseSemVer("1.2.3");
      expect(v).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it("parses semver with prerelease", () => {
      const v = parseSemVer("1.2.3-beta.1");
      expect(v).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "beta.1" });
    });

    it("returns null for invalid semver", () => {
      expect(parseSemVer("1.2")).toBeNull();
      expect(parseSemVer("abc")).toBeNull();
      expect(parseSemVer("")).toBeNull();
    });
  });

  describe("compareVersions", () => {
    it("compares major versions", () => {
      expect(compareVersions(parseSemVer("2.0.0")!, parseSemVer("1.0.0")!)).toBe(1);
      expect(compareVersions(parseSemVer("1.0.0")!, parseSemVer("2.0.0")!)).toBe(-1);
    });

    it("compares minor versions", () => {
      expect(compareVersions(parseSemVer("1.2.0")!, parseSemVer("1.1.0")!)).toBe(1);
    });

    it("compares patch versions", () => {
      expect(compareVersions(parseSemVer("1.2.3")!, parseSemVer("1.2.2")!)).toBe(1);
    });

    it("equal versions return 0", () => {
      expect(compareVersions(parseSemVer("1.2.3")!, parseSemVer("1.2.3")!)).toBe(0);
    });

    it("prerelease has lower precedence", () => {
      expect(compareVersions(parseSemVer("1.2.3-beta")!, parseSemVer("1.2.3")!)).toBe(-1);
    });
  });

  describe("satisfiesRange", () => {
    it("handles >= range", () => {
      const v = parseSemVer("1.5.0")!;
      expect(satisfiesRange(v, ">=1.0.0")).toBe(true);
      expect(satisfiesRange(v, ">=2.0.0")).toBe(false);
    });

    it("handles < range", () => {
      const v = parseSemVer("1.5.0")!;
      expect(satisfiesRange(v, "<2.0.0")).toBe(true);
      expect(satisfiesRange(v, "<1.0.0")).toBe(false);
    });

    it("handles ~ (tilde) range", () => {
      const v = parseSemVer("1.2.5")!;
      expect(satisfiesRange(v, "~1.2.0")).toBe(true);
      expect(satisfiesRange(v, "~1.3.0")).toBe(false);
    });

    it("handles ^ (caret) range", () => {
      const v = parseSemVer("1.5.0")!;
      expect(satisfiesRange(v, "^1.0.0")).toBe(true);
      expect(satisfiesRange(v, "^2.0.0")).toBe(false);
    });

    it("handles exact version", () => {
      const v = parseSemVer("1.2.3")!;
      expect(satisfiesRange(v, "1.2.3")).toBe(true);
      expect(satisfiesRange(v, "1.2.4")).toBe(false);
    });
  });

  describe("satisfiesCompatibility", () => {
    it("handles space-separated ranges (AND logic)", () => {
      expect(satisfiesCompatibility("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
      expect(satisfiesCompatibility("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    });

    it("empty range = always compatible", () => {
      expect(satisfiesCompatibility("1.0.0", "")).toBe(true);
    });

    it("invalid version returns false", () => {
      expect(satisfiesCompatibility("abc", ">=1.0.0")).toBe(false);
    });
  });

  describe("checkManifestCompatibility", () => {
    it("same version = compatible", () => {
      expect(checkManifestCompatibility(1, 1)).toBe("compatible");
    });

    it("different minor = regenerable", () => {
      expect(checkManifestCompatibility(102, 101)).toBe("regenerable");
    });

    it("different major = incompatible", () => {
      expect(checkManifestCompatibility(200, 100)).toBe("incompatible");
    });
  });

  describe("checkPromptCompatibility", () => {
    it("same hash = compatible", () => {
      expect(checkPromptCompatibility("abc123", "abc123")).toBe("compatible");
    });

    it("different hash = regenerable", () => {
      expect(checkPromptCompatibility("abc123", "def456")).toBe("regenerable");
    });
  });
});
