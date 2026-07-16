import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

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

export class IsolatedProcessPair {
  public tempRoot!: string;
  public nonce!: string;
  public adminToken!: string;
  public internalServiceToken!: string;
  public backendPort!: number;
  public sidecarPort!: number;
  public sidecarUrl!: string;
  public backendUrl!: string;

  private backendProcess: ChildProcess | null = null;
  private sidecarProcess: ChildProcess | null = null;

  async start(projectRoot: string): Promise<void> {
    this.nonce = randomBytes(16).toString("hex");
    this.adminToken = randomBytes(16).toString("hex");
    this.internalServiceToken = randomBytes(16).toString("hex");

    this.tempRoot = await mkdtemp(join(tmpdir(), "projectflow-eval-"));
    await mkdir(join(this.tempRoot, "uploads"), { recursive: true });
    await writeFile(join(this.tempRoot, ".evaluator-ownership-marker"), this.nonce, "utf-8");

    this.backendPort = await findFreePort();
    this.sidecarPort = await findFreePort();

    this.backendUrl = `http://127.0.0.1:${this.backendPort}`;
    this.sidecarUrl = `http://127.0.0.1:${this.sidecarPort}`;

    const backendPath = resolve(projectRoot, "backend");
    const pythonExec = join(backendPath, ".venv", "bin", "python");

    // Spawn Backend
    this.backendProcess = spawn(
      pythonExec,
      ["-m", "uvicorn", "app.main:app", "--port", String(this.backendPort), "--host", "127.0.0.1"],
      {
        cwd: backendPath,
        env: {
          ...process.env,
          APP_ENV: "evaluation",
          DATABASE_URL: `sqlite:///${this.tempRoot}/projectflow_eval.sqlite`,
          UPLOAD_DIR: `${this.tempRoot}/uploads`,
          DEMO_ADMIN_TOKEN: this.adminToken,
          INTERNAL_SERVICE_TOKEN: this.internalServiceToken,
          EVALUATION_NONCE: this.nonce,
          EVALUATION_TEMP_ROOT: this.tempRoot,
        },
        stdio: "ignore",
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
          ...process.env,
          APP_ENV: "evaluation",
          AGENT_BRIDGE_HOST: "127.0.0.1",
          AGENT_BRIDGE_PORT: String(this.sidecarPort),
          FASTAPI_BASE_URL: this.backendUrl,
          INTERNAL_SERVICE_TOKEN: this.internalServiceToken,
          DEMO_ADMIN_TOKEN: this.adminToken,
          EVALUATION_NONCE: this.nonce,
          EVALUATION_TEMP_ROOT: this.tempRoot,
          MODEL_CONFIGS_PATH: resolve(projectRoot, "agent-bridge/model-configs.json"),
          DOTENV_PATH: join(this.tempRoot, ".env"),
          DEEPSEEK_API_KEY: "mock-key",
          XIAOMI_API_KEY: "mock-key",
          XIAOMI_TOKEN_PLAN_CN_API_KEY: "mock-key",
        },
        stdio: "ignore",
      }
    );

    // Wait for both to be healthy
    try {
      await Promise.all([
        this.waitHealth(`${this.backendUrl}/api/health`),
        this.waitHealth(`${this.sidecarUrl}/health`),
      ]);
    } catch (err) {
      await this.destroy();
      throw err;
    }
  }

  private async waitHealth(url: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.backendProcess?.killed || this.sidecarProcess?.killed) {
        throw new Error("One of the processes exited early");
      }
      try {
        const res = await fetch(url, {
          headers: { "X-Evaluation-Nonce": this.nonce },
        });
        if (res.ok) {
          const data = await res.json() as any;
          if (data && data.app_env === "evaluation") {
            return;
          }
        }
      } catch {
        // ignore connection failure, wait and retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for service at ${url}`);
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
