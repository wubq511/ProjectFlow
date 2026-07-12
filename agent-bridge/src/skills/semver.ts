/**
 * Semver — lightweight semantic version parsing and range checking.
 *
 * Used for manifest, skill, and prompt kernel compatibility checking
 * during checkpoint resume. No external dependencies.
 *
 * Supports:
 * - Exact version matching (1.2.3)
 * - Range expressions: >=1.0.0, <2.0.0, ~1.2.x, ^1.0.0
 * - Compatibility ranges: ">=1.0.0 <2.0.0"
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 6
 */

/**
 * Parsed semantic version.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Parse a semver string like "1.2.3" or "1.2.3-beta.1".
 * Returns null if not a valid semver.
 */
export function parseSemVer(version: string): SemVer | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
    prerelease: match[4],
  };
}

/**
 * Compare two semver versions.
 * Returns -1, 0, or 1.
 */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // Prerelease versions have lower precedence than release
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
  }
  return 0;
}

/**
 * Check if version a satisfies a simple range expression.
 * Supports: >=X.Y.Z, <=X.Y.Z, >X.Y.Z, <X.Y.Z, ~X.Y.Z, ^X.Y.Z, exact
 */
export function satisfiesRange(version: SemVer, range: string): boolean {
  const trimmed = range.trim();

  // Exact match
  if (/^\d+\.\d+\.\d+/.test(trimmed)) {
    const exact = parseSemVer(trimmed);
    return exact !== null && compareVersions(version, exact) === 0;
  }

  // >= or <=
  if (trimmed.startsWith(">=")) {
    const target = parseSemVer(trimmed.slice(2).trim());
    return target !== null && compareVersions(version, target) >= 0;
  }
  if (trimmed.startsWith("<=")) {
    const target = parseSemVer(trimmed.slice(2).trim());
    return target !== null && compareVersions(version, target) <= 0;
  }

  // > or <
  if (trimmed.startsWith(">")) {
    const target = parseSemVer(trimmed.slice(1).trim());
    return target !== null && compareVersions(version, target) > 0;
  }
  if (trimmed.startsWith("<")) {
    const target = parseSemVer(trimmed.slice(1).trim());
    return target !== null && compareVersions(version, target) < 0;
  }

  // ~ (tilde): same major.minor, patch >= specified
  if (trimmed.startsWith("~")) {
    const target = parseSemVer(trimmed.slice(1).trim());
    if (!target) return false;
    return version.major === target.major &&
           version.minor === target.minor &&
           version.patch >= target.patch;
  }

  // ^ (caret): same major, minor >= specified
  if (trimmed.startsWith("^")) {
    const target = parseSemVer(trimmed.slice(1).trim());
    if (!target) return false;
    return version.major === target.major &&
           (version.minor > target.minor ||
            (version.minor === target.minor && version.patch >= target.patch));
  }

  return false;
}

/**
 * Check if a version satisfies a compatibility range string.
 * Range can be a single expression or space-separated (AND logic).
 * Examples: ">=1.0.0 <2.0.0", "^1.0.0", "~1.2.0"
 */
export function satisfiesCompatibility(versionStr: string, rangeStr: string): boolean {
  const version = parseSemVer(versionStr);
  if (!version) return false;

  // Empty range = always compatible
  if (!rangeStr || rangeStr.trim() === "") return true;

  const ranges = rangeStr.trim().split(/\s+/);
  return ranges.every((range) => satisfiesRange(version, range));
}

/**
 * Check manifest version compatibility.
 * Returns: "compatible" | "regenerable" | "incompatible"
 */
export function checkManifestCompatibility(
  currentVersion: number,
  checkpointVersion: number,
): "compatible" | "regenerable" | "incompatible" {
  if (currentVersion === checkpointVersion) return "compatible";
  // Same major version = regenerable (context can be rebuilt)
  if (Math.floor(currentVersion / 100) === Math.floor(checkpointVersion / 100)) return "regenerable";
  return "incompatible";
}

/**
 * Check prompt kernel compatibility.
 * Returns: "compatible" | "regenerable" | "incompatible"
 */
export function checkPromptCompatibility(
  currentHash: string,
  checkpointHash: string,
): "compatible" | "regenerable" | "incompatible" {
  if (currentHash === checkpointHash) return "compatible";
  // Different hash = can regenerate context (dynamic content changed)
  return "regenerable";
}
