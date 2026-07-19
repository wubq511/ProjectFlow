import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
] as const;

/** Keep host credentials and target URLs out of evaluator-owned children. */
export function buildIsolatedChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "string" ? 0 : address?.port ?? 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export function isExpectedEvaluationIdentity(
  data: unknown,
  expectedService: string,
  expectedInstanceId: string,
): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return record.app_env === "evaluation"
    && record.service === expectedService
    && record.evaluation_instance_id === expectedInstanceId;
}

export class IsolatedProcessPair {
  public tempRoot!: string;
  public nonce!: string;
  public instanceId!: string;
  public adminToken!: string;
  public internalServiceToken!: string;
  public backendPort!: number;
  public sidecarPort!: number;
  public sidecarUrl!: string;
  public backendUrl!: string;
  public resolvedModel: { provider: string; name: string; confirmedBy: string } | null = null;

  private backendProcess: ChildProcess | null = null;
  private sidecarProcess: ChildProcess | null = null;
  private diagnosticBuffer = "";

  private captureDiagnostics(process: ChildProcess, label: string): void {
    const append = (chunk: unknown) => {
      const value = String(chunk);
      if (label === "backend" && !value.includes("ERROR")) return;
      this.diagnosticBuffer = `${this.diagnosticBuffer}${label}: ${value}`.slice(-32_768);
    };
    process.stdout?.on("data", append);
    process.stderr?.on("data", append);
  }

  diagnosticTail(): string {
    return this.diagnosticBuffer;
  }

  async start(projectRoot: string, model = "mock:mock-model"): Promise<void> {
    this.nonce = randomBytes(16).toString("hex");
    this.instanceId = randomBytes(16).toString("hex");
    this.adminToken = randomBytes(16).toString("hex");
    this.internalServiceToken = randomBytes(16).toString("hex");

    this.tempRoot = await mkdtemp(join(tmpdir(), "projectflow-eval-"));
    await mkdir(join(this.tempRoot, "uploads"), { recursive: true });
    await writeFile(
      join(this.tempRoot, ".evaluator-ownership-marker"),
      JSON.stringify({ nonce: this.nonce, instanceId: this.instanceId }),
      { encoding: "utf-8", mode: 0o600 },
    );
    const isolatedModelConfigsPath = join(this.tempRoot, "model-configs.json");
    const separator = model.indexOf(":");
    const provider = model.slice(0, separator);
    const name = model.slice(separator + 1);
    const modelConfigs = JSON.parse(
      await readFile(resolve(projectRoot, "agent-bridge", "model-configs.json"), "utf-8"),
    ) as { models?: Array<Record<string, unknown>> };
    if (!Array.isArray(modelConfigs.models)) {
      throw new Error("model-configs.json 缺少 models 数组");
    }
    let selected = false;
    modelConfigs.models = modelConfigs.models.map((entry) => {
      const isSelected = entry.provider === provider && entry.name === name;
      selected ||= isSelected;
      return { ...entry, isDefault: isSelected };
    });
    if (!selected) {
      throw new Error(`模型 ${model} 未在 evaluator-owned config 中注册`);
    }
    await writeFile(isolatedModelConfigsPath, JSON.stringify(modelConfigs, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });

    this.backendPort = await findFreePort();
    this.sidecarPort = await findFreePort();

    this.backendUrl = `http://127.0.0.1:${this.backendPort}`;
    this.sidecarUrl = `http://127.0.0.1:${this.sidecarPort}`;

    const backendPath = resolve(projectRoot, "backend");
    const pythonExec = join(backendPath, ".venv", "bin", "python");
    const isolatedBaseEnv = buildIsolatedChildEnv();

    // Spawn Backend
    this.backendProcess = spawn(
      pythonExec,
      ["-m", "uvicorn", "app.main:app", "--port", String(this.backendPort), "--host", "127.0.0.1"],
      {
        // Keep pydantic-settings from auto-loading backend/.env.
        cwd: this.tempRoot,
        env: {
          ...isolatedBaseEnv,
          PYTHONPATH: backendPath,
          APP_ENV: "evaluation",
          DATABASE_URL: `sqlite:///${this.tempRoot}/projectflow_eval.sqlite`,
          UPLOAD_DIR: `${this.tempRoot}/uploads`,
          DEMO_ADMIN_TOKEN: this.adminToken,
          INTERNAL_SERVICE_TOKEN: this.internalServiceToken,
          EVALUATION_NONCE: this.nonce,
          EVALUATION_INSTANCE_ID: this.instanceId,
          EVALUATION_TEMP_ROOT: this.tempRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // Spawn Sidecar
    const sidecarPath = resolve(projectRoot, "agent-bridge");
    const tsxExec = join(sidecarPath, "node_modules", ".bin", "tsx");

    this.sidecarProcess = spawn(
      tsxExec,
      ["src/index.ts"],
      {
        cwd: sidecarPath,
        env: {
          ...isolatedBaseEnv,
          APP_ENV: "evaluation",
          AGENT_BRIDGE_HOST: "127.0.0.1",
          AGENT_BRIDGE_PORT: String(this.sidecarPort),
          FASTAPI_BASE_URL: this.backendUrl,
          DEFAULT_MODEL_PROVIDER: provider,
          DEFAULT_MODEL_NAME: name,
          INTERNAL_SERVICE_TOKEN: this.internalServiceToken,
          DEMO_ADMIN_TOKEN: this.adminToken,
          EVALUATION_NONCE: this.nonce,
          EVALUATION_INSTANCE_ID: this.instanceId,
          EVALUATION_TEMP_ROOT: this.tempRoot,
          MODEL_CONFIGS_PATH: isolatedModelConfigsPath,
          DOTENV_PATH: join(this.tempRoot, ".env"),
          ...(process.env.EVALUATION_DEBUG === "1" ? { EVALUATION_DEBUG: "1" } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    this.captureDiagnostics(this.backendProcess, "backend");
    this.captureDiagnostics(this.sidecarProcess, "sidecar");

    // Wait for both to be healthy
    try {
      const [, sidecarHealth] = await Promise.all([
        this.waitHealth(`${this.backendUrl}/api/health`, "projectflow-backend"),
        this.waitHealth(`${this.sidecarUrl}/health`, "agent-bridge"),
      ]);
      const resolved = sidecarHealth.resolved_model;
      if (resolved && typeof resolved === "object") {
        const value = resolved as Record<string, unknown>;
        if (
          typeof value.provider === "string"
          && typeof value.name === "string"
          && value.confirmed_by === "sidecar_health"
        ) {
          this.resolvedModel = {
            provider: value.provider,
            name: value.name,
            confirmedBy: "sidecar_health",
          };
        }
      }
    } catch (err) {
      await this.destroy();
      throw err;
    }
  }

  private async waitHealth(
    url: string,
    expectedService: string,
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        this.backendProcess?.exitCode !== null || this.backendProcess?.signalCode !== null
        || this.sidecarProcess?.exitCode !== null || this.sidecarProcess?.signalCode !== null
      ) {
        throw new Error("评测 backend 或 sidecar 进程提前退出");
      }
      try {
        const res = await fetch(url, {
          headers: {
            "X-Evaluation-Nonce": this.nonce,
            "X-Evaluation-Instance-Id": this.instanceId,
          },
        });
        if (res.ok) {
          const data = await res.json() as any;
          if (isExpectedEvaluationIdentity(data, expectedService, this.instanceId)) {
            return data as Record<string, unknown>;
          }
        }
      } catch {
        // ignore connection failure, wait and retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`等待评测服务健康检查超时: ${url}`);
  }

  async destroy(): Promise<void> {
    const backend = this.backendProcess;
    const sidecar = this.sidecarProcess;
    this.backendProcess = null;
    this.sidecarProcess = null;

    if (backend) {
      backend.kill("SIGKILL");
    }
    if (sidecar) {
      sidecar.kill("SIGKILL");
    }

    try {
      await Promise.all([
        waitProcessExit(backend),
        waitProcessExit(sidecar),
      ]);
    } catch (err: any) {
      console.error(`[isolation] 进程关闭异常或超时: ${err?.message || err}`);
      throw new Error(`清理沙箱实例进程失败: ${err?.message || err}`);
    }

    if (this.tempRoot) {
      try {
        await rm(this.tempRoot, { recursive: true, force: true });
      } catch (err: any) {
        console.error(`[isolation] 清理临时沙箱根目录失败 ${this.tempRoot}: ${err?.message || err}`);
        throw new Error(`沙箱目录物理删除失败: ${err?.message || err}`);
      }
    }
  }
}

function waitProcessExit(proc: ChildProcess | null, timeoutMs = 5000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (err: any) => {
      cleanup();
      reject(err);
    };
    proc.on("exit", onExit);
    proc.on("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待进程退出超时"));
    }, timeoutMs);
  });
}
