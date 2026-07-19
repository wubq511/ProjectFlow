import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  EvaluationArtifact,
  EvaluationStatusRecord,
  Grade,
  IntegrityIndex,
  RunManifest,
  ScenarioObservation,
} from "./contract.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

const SAFE_RELATIVE_PATH = /^[a-zA-Z0-9_./-]+$/;

function assertSafeRelativePath(path: string): void {
  if (!SAFE_RELATIVE_PATH.test(path) || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new EvaluationValidationError(`非法 artifact 相对路径: ${path}`);
  }
}

function assertNoSymlinkPath(root: string, target: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new EvaluationInfrastructureError(`artifact 根目录不允许为符号链接: ${root}`);
  }
  const rootReal = realpathSync(root);
  const relativePath = target === root ? "" : target.slice(root.length + 1);
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new EvaluationInfrastructureError(`artifact 路径不允许包含符号链接: ${current}`);
      }
      const currentReal = realpathSync(current);
      if (currentReal !== rootReal && !currentReal.startsWith(`${rootReal}${sep}`)) {
        throw new EvaluationInfrastructureError(`artifact 路径真实位置越界: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSupportedSchema(value: unknown, label: string): asserts value is { schemaVersion: number } {
  if (!value || typeof value !== "object") {
    throw new EvaluationInfrastructureError(`${label} 不是 JSON 对象`);
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version !== EVALUATION_SCHEMA_VERSION) {
    throw new EvaluationInfrastructureError(
      `${label} schemaVersion ${String(version)} 不受支持；当前仅支持 ${EVALUATION_SCHEMA_VERSION}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  return readFile(path).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function writeAtomicMutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function publishImmutable(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    // Hard-link publication is atomic and fails when the immutable destination already exists.
    await link(temp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new EvaluationInfrastructureError(`拒绝覆盖已存在的 immutable artifact: ${path}`);
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  await chmod(path, 0o400);
  return sha256(content);
}

async function verifyHash(path: string, expected: string): Promise<string> {
  const content = await readFile(path, "utf-8");
  const actual = sha256(content);
  if (actual !== expected) {
    throw new EvaluationInfrastructureError(`artifact 哈希校验失败: ${path}`);
  }
  return content;
}

function sameResumeContract(existing: RunManifest, expected: RunManifest): boolean {
  return stableStringify({
    schemaVersion: existing.schemaVersion,
    runId: existing.runId,
    preset: existing.preset,
    model: existing.model,
    scenarios: existing.scenarios,
    budget: existing.budget,
    provenance: existing.provenance,
    v3: existing.v3,
  }) === stableStringify({
    schemaVersion: expected.schemaVersion,
    runId: expected.runId,
    preset: expected.preset,
    model: expected.model,
    scenarios: expected.scenarios,
    budget: expected.budget,
    provenance: expected.provenance,
    v3: expected.v3,
  });
}

export interface LoadedCheckpoint {
  manifest: RunManifest;
  observations: Map<string, ScenarioObservation>;
  grades: Map<string, Grade>;
  completedArtifact?: EvaluationArtifact;
}

export class EvaluationArtifactStore {
  readonly runDir: string;
  readonly relativeRunDir: string;
  private readonly artifactRoot: string;
  private readonly stagingDir: string;
  private readonly lockPath: string;
  private lockHeld = false;

  constructor(
    private readonly projectRoot: string,
    readonly runId: string,
    evaluatorTempRoot: string,
  ) {
    this.relativeRunDir = `agent-bridge/artifacts/${runId}`;
    this.runDir = resolve(projectRoot, this.relativeRunDir);
    this.stagingDir = resolve(evaluatorTempRoot, "artifacts-staging");
    this.lockPath = join(this.runDir, ".active.lock");
    this.artifactRoot = resolve(projectRoot, "agent-bridge", "artifacts");
    if (!(this.runDir === this.artifactRoot || this.runDir.startsWith(`${this.artifactRoot}${sep}`))) {
      throw new EvaluationValidationError("runId 导致 artifact 目录越界");
    }
  }

  private async acquireLock(): Promise<void> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700);
    try {
      const handle = await open(this.lockPath, "wx", 0o600);
      await handle.writeFile(json({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      await handle.close();
      this.lockHeld = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let stale = false;
    try {
      const lock = JSON.parse(await readFile(this.lockPath, "utf-8")) as { pid?: number };
      if (!Number.isInteger(lock.pid) || (lock.pid ?? 0) <= 0) {
        stale = true;
      } else {
        try {
          process.kill(lock.pid!, 0);
        } catch (error) {
          stale = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new EvaluationInfrastructureError(`运行 ${this.runId} 已被另一个 evaluator 进程锁定`);
    }
    await rm(this.lockPath, { force: true });
    const handle = await open(this.lockPath, "wx", 0o600);
    await handle.writeFile(json({ pid: process.pid, acquiredAt: new Date().toISOString(), recoveredStaleLock: true }));
    await handle.close();
    this.lockHeld = true;
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    await rm(this.lockPath, { force: true });
    this.lockHeld = false;
  }

  private finalPath(relativePath: string): string {
    assertSafeRelativePath(relativePath);
    const path = join(this.runDir, relativePath);
    assertNoSymlinkPath(this.artifactRoot, path);
    return path;
  }

  private stagingPath(relativePath: string): string {
    assertSafeRelativePath(relativePath);
    const path = join(this.stagingDir, relativePath);
    assertNoSymlinkPath(this.stagingDir, path);
    return path;
  }

  private async stageAndPublish(relativePath: string, value: unknown): Promise<string> {
    const content = json(value);
    const staged = this.stagingPath(relativePath);
    await writeAtomicMutable(staged, content);
    const stagedHash = sha256(await readFile(staged));
    const publishedHash = await publishImmutable(this.finalPath(relativePath), content);
    if (stagedHash !== publishedHash) {
      throw new EvaluationInfrastructureError(`staging 与 published artifact 哈希不一致: ${relativePath}`);
    }
    return publishedHash;
  }

  async initialize(expected: RunManifest, resume: boolean): Promise<LoadedCheckpoint> {
    const artifactsRoot = resolve(this.projectRoot, "agent-bridge", "artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    assertNoSymlinkPath(this.artifactRoot, this.runDir);
    const runExists = await pathExists(join(this.runDir, "manifest.json"));
    if (runExists && !resume) {
      throw new EvaluationValidationError(`运行 ID ${this.runId} 已存在；使用 --resume 或更换 run-id`);
    }
    if (!runExists && resume) {
      throw new EvaluationValidationError(`运行 ID ${this.runId} 不存在，无法恢复`);
    }

    await this.acquireLock();
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await chmod(this.stagingDir, 0o700);

    if (!runExists) {
      const manifestHash = await this.stageAndPublish("manifest.json", expected);
      await this.stageAndPublish("checksums/manifest.json", {
        schemaVersion: EVALUATION_SCHEMA_VERSION,
        sha256: manifestHash,
      });
      await this.writeStatus("running", []);
      return { manifest: expected, observations: new Map(), grades: new Map() };
    }

    const manifestRawBeforeChecksum = await readFile(this.finalPath("manifest.json"), "utf-8");
    const manifestChecksumPath = this.finalPath("checksums/manifest.json");
    if (!(await pathExists(manifestChecksumPath))) {
      const uncommittedManifest = JSON.parse(manifestRawBeforeChecksum) as RunManifest;
      if (!sameResumeContract(uncommittedManifest, expected)) {
        throw new EvaluationInfrastructureError("未完成的 manifest 与当前 resume 契约不一致");
      }
      await this.stageAndPublish("checksums/manifest.json", {
        schemaVersion: EVALUATION_SCHEMA_VERSION,
        sha256: sha256(manifestRawBeforeChecksum),
      });
    }
    const manifestChecksum = JSON.parse(await readFile(manifestChecksumPath, "utf-8")) as { sha256?: string };
    assertSupportedSchema(manifestChecksum, "checksums/manifest.json");
    if (!manifestChecksum.sha256) {
      throw new EvaluationInfrastructureError("manifest checksum 缺失");
    }
    const manifestRaw = await verifyHash(this.finalPath("manifest.json"), manifestChecksum.sha256);
    const manifest = JSON.parse(manifestRaw) as RunManifest;
    assertSupportedSchema(manifest, "manifest.json");
    if (!sameResumeContract(manifest, expected)) {
      throw new EvaluationValidationError("resume 被拒绝：场景、预算、模型或代码/工作树指纹已变化");
    }

    const reportPath = this.finalPath("report.json");
    const integrityPath = this.finalPath("integrity.json");
    const reportExists = await pathExists(reportPath);
    const integrityExists = await pathExists(integrityPath);
    if (reportExists && !integrityExists) {
      // integrity.json is the final commit marker; an orphan report is safe to discard.
      await rm(reportPath, { force: true });
    } else if (!reportExists && integrityExists) {
      throw new EvaluationInfrastructureError("integrity.json 存在但 report.json 缺失");
    }
    const completedArtifact = reportExists && integrityExists
      ? await this.readVerifiedArtifact()
      : undefined;
    if (completedArtifact) {
      return { manifest, observations: new Map(), grades: new Map(), completedArtifact };
    }

    const observations = new Map<string, ScenarioObservation>();
    const grades = new Map<string, Grade>();
    const obsDir = this.finalPath("observations");
    const gradeDir = this.finalPath("grades");
    const obsFiles = await readdir(obsDir).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
    const gradeFiles = await readdir(gradeDir).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
    const ids = new Set([
      ...obsFiles.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)),
      ...gradeFiles.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)),
    ]);
    for (const id of ids) {
      if (!expected.scenarios.some((scenario) => scenario.scenarioId === id)) {
        throw new EvaluationInfrastructureError(`发现 manifest 未声明的 checkpoint: ${id}`);
      }
      const checksumPath = this.finalPath(`checksums/${id}.json`);
      const checksumRaw = await readFile(checksumPath, "utf-8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!checksumRaw) {
        // The checksum is the commit marker. Files published before a crash are not
        // completed evidence and may be discarded safely before rerunning the case.
        await rm(this.finalPath(`observations/${id}.json`), { force: true });
        await rm(this.finalPath(`grades/${id}.json`), { force: true });
        continue;
      }
      const checksum = JSON.parse(checksumRaw) as { observationSha256?: string; gradeSha256?: string };
      assertSupportedSchema(checksum, `checksums/${id}.json`);
      if (!checksum.observationSha256 || !checksum.gradeSha256) {
        throw new EvaluationInfrastructureError(`checkpoint ${id} 不完整`);
      }
      const obsRaw = await verifyHash(this.finalPath(`observations/${id}.json`), checksum.observationSha256);
      const gradeRaw = await verifyHash(this.finalPath(`grades/${id}.json`), checksum.gradeSha256);
      const observation = JSON.parse(obsRaw) as ScenarioObservation;
      const grade = JSON.parse(gradeRaw) as Grade;
      assertSupportedSchema(observation, `observations/${id}.json`);
      assertSupportedSchema(grade, `grades/${id}.json`);
      if (observation.scenarioId !== id || grade.scenarioId !== id) {
        throw new EvaluationInfrastructureError(`checkpoint ${id} 的 scenarioId 不一致`);
      }
      observations.set(id, observation);
      grades.set(id, grade);
    }
    return { manifest, observations, grades };
  }

  async publishCheckpoint(observation: ScenarioObservation, grade: Grade): Promise<void> {
    if (observation.scenarioId !== grade.scenarioId) {
      throw new EvaluationInfrastructureError("observation 与 grade 的 scenarioId 不一致");
    }
    const id = observation.scenarioId;
    const observationSha256 = await this.stageAndPublish(`observations/${id}.json`, observation);
    const gradeSha256 = await this.stageAndPublish(`grades/${id}.json`, grade);
    await this.stageAndPublish(`checksums/${id}.json`, {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      observationSha256,
      gradeSha256,
    });
  }

  /**
   * Publish a V4 Repair Packet as an immutable artifact under
   * `repair-packets/<packetId>.json`. The packet atomically enters the
   * SHA-256 result graph (its hash is included in `integrity.json` via
   * `evidenceEntries()`).
   *
   * Returns the artifact-relative path and SHA-256 of the published
   * packet. Callers should record these in the diagnosis record's
   * evidence references.
   *
   * Issue #97 §7: packets must atomically enter the SHA-256 result graph.
   */
  async publishRepairPacket(
    packet: unknown,
    packetId: string,
  ): Promise<{ artifactPath: string; sha256: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(packetId)) {
      throw new EvaluationValidationError(`非法 repair packet ID: ${packetId}`);
    }
    const relativePath = `repair-packets/${packetId}.json`;
    const hash = await this.stageAndPublish(relativePath, packet);
    return { artifactPath: relativePath, sha256: hash };
  }

  /**
   * Publish a V4 diagnosis record as an immutable artifact under
   * `diagnoses/<diagnosisId>.json`. Diagnosis records enter the SHA-256
   * result graph so they can be referenced by repair packets.
   */
  async publishDiagnosis(
    diagnosis: unknown,
    diagnosisId: string,
  ): Promise<{ artifactPath: string; sha256: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(diagnosisId)) {
      throw new EvaluationValidationError(`非法 diagnosis ID: ${diagnosisId}`);
    }
    const relativePath = `diagnoses/${diagnosisId}.json`;
    const hash = await this.stageAndPublish(relativePath, diagnosis);
    return { artifactPath: relativePath, sha256: hash };
  }

  /**
   * Publish a V4 issue cluster as an immutable artifact under
   * `clusters/<clusterId>.json`.
   */
  async publishIssueCluster(
    cluster: unknown,
    clusterId: string,
  ): Promise<{ artifactPath: string; sha256: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(clusterId)) {
      throw new EvaluationValidationError(`非法 cluster ID: ${clusterId}`);
    }
    const relativePath = `clusters/${clusterId}.json`;
    const hash = await this.stageAndPublish(relativePath, cluster);
    return { artifactPath: relativePath, sha256: hash };
  }

  /**
   * Publish a V4 counterfactual record as an immutable artifact under
   * `counterfactuals/<counterfactualId>.json`.
   */
  async publishCounterfactual(
    record: unknown,
    counterfactualId: string,
  ): Promise<{ artifactPath: string; sha256: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(counterfactualId)) {
      throw new EvaluationValidationError(`非法 counterfactual ID: ${counterfactualId}`);
    }
    const relativePath = `counterfactuals/${counterfactualId}.json`;
    const hash = await this.stageAndPublish(relativePath, record);
    return { artifactPath: relativePath, sha256: hash };
  }

  /**
   * Publish the V4 RCA benchmark report as an immutable artifact under
   * `rca-benchmark.json`.
   */
  async publishRcaBenchmarkReport(
    report: unknown,
  ): Promise<{ artifactPath: string; sha256: string }> {
    const relativePath = "rca-benchmark.json";
    const hash = await this.stageAndPublish(relativePath, report);
    return { artifactPath: relativePath, sha256: hash };
  }

  /**
   * Read a published repair packet by ID. Verifies the SHA-256 against
   * the integrity index when available.
   */
  async readRepairPacket(packetId: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]+$/.test(packetId)) {
      throw new EvaluationValidationError(`非法 repair packet ID: ${packetId}`);
    }
    const relativePath = `repair-packets/${packetId}.json`;
    const content = await readFile(this.finalPath(relativePath), "utf-8");
    return JSON.parse(content);
  }

  /**
   * Read a published diagnosis record by ID.
   */
  async readDiagnosis(diagnosisId: string): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]+$/.test(diagnosisId)) {
      throw new EvaluationValidationError(`非法 diagnosis ID: ${diagnosisId}`);
    }
    const relativePath = `diagnoses/${diagnosisId}.json`;
    const content = await readFile(this.finalPath(relativePath), "utf-8");
    return JSON.parse(content);
  }

  async writeStatus(
    status: EvaluationStatusRecord["status"],
    completedScenarioIds: string[],
    message?: string,
  ): Promise<void> {
    const record: EvaluationStatusRecord = {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      runId: this.runId,
      status,
      completedScenarioIds,
      updatedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
    await writeAtomicMutable(this.finalPath("status.json"), json(record));
  }

  private async evidenceEntries(): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    const add = async (relativePath: string) => {
      entries[relativePath] = sha256(await readFile(this.finalPath(relativePath)));
    };
    await add("manifest.json");
    // V4 directories (repair-packets, diagnoses, clusters, counterfactuals)
    // are included in the SHA-256 result graph so that immutable V4
    // artifacts are tamper-evident. Issue #97 §7.
    for (const dir of [
      "observations",
      "grades",
      "checksums",
      "repair-packets",
      "diagnoses",
      "clusters",
      "counterfactuals",
    ] as const) {
      const files = await readdir(this.finalPath(dir)).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
      for (const file of files.filter((item) => item.endsWith(".json")).sort()) {
        await add(`${dir}/${file}`);
      }
    }
    // V4 RCA benchmark report (single file at run root).
    const rcaBenchmarkPath = this.finalPath("rca-benchmark.json");
    if (await pathExists(rcaBenchmarkPath)) {
      await add("rca-benchmark.json");
    }
    return entries;
  }

  async finalize(baseArtifact: Omit<EvaluationArtifact, "evidenceRootSha256" | "integrityRootSha256">): Promise<EvaluationArtifact> {
    const entries = await this.evidenceEntries();
    const evidenceRootSha256 = sha256(stableStringify(entries));
    const reportCore: EvaluationArtifact = {
      ...baseArtifact,
      evidenceRootSha256,
    };
    const integrityRootSha256 = sha256(stableStringify({ entries, report: reportCore }));
    const report: EvaluationArtifact = { ...reportCore, integrityRootSha256 };
    const reportSha256 = await publishImmutable(this.finalPath("report.json"), json(report));
    const integrity: IntegrityIndex = {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      algorithm: "sha256",
      entries,
      evidenceRootSha256,
      reportSha256,
      integrityRootSha256,
    };
    await publishImmutable(this.finalPath("integrity.json"), json(integrity));
    await this.writeStatus(report.status, report.observations.map((observation) => observation.scenarioId));
    return report;
  }

  async readStatus(): Promise<EvaluationStatusRecord> {
    const status = JSON.parse(await readFile(this.finalPath("status.json"), "utf-8")) as EvaluationStatusRecord;
    assertSupportedSchema(status, "status.json");
    return status;
  }

  async readVerifiedArtifact(): Promise<EvaluationArtifact> {
    const integrity = JSON.parse(await readFile(this.finalPath("integrity.json"), "utf-8")) as IntegrityIndex;
    assertSupportedSchema(integrity, "integrity.json");
    if (integrity.algorithm !== "sha256") {
      throw new EvaluationInfrastructureError(`integrity algorithm ${String(integrity.algorithm)} 不受支持`);
    }
    const reportRaw = await verifyHash(this.finalPath("report.json"), integrity.reportSha256);
    for (const [relativePath, expectedHash] of Object.entries(integrity.entries)) {
      await verifyHash(this.finalPath(relativePath), expectedHash);
    }
    if (sha256(stableStringify(integrity.entries)) !== integrity.evidenceRootSha256) {
      throw new EvaluationInfrastructureError("evidence root hash 不一致");
    }
    const report = JSON.parse(reportRaw) as EvaluationArtifact;
    assertSupportedSchema(report, "report.json");
    const { integrityRootSha256: _storedRoot, ...reportCore } = report;
    const expectedRoot = sha256(stableStringify({ entries: integrity.entries, report: reportCore }));
    if (expectedRoot !== integrity.integrityRootSha256 || report.integrityRootSha256 !== expectedRoot) {
      throw new EvaluationInfrastructureError("integrity root hash 不一致");
    }
    return report;
  }
}
