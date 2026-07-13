/**
 * ProjectFlow Agent Bridge Sidecar
 *
 * TypeScript sidecar process that orchestrates the Agent Runtime loop.
 * Communicates with FastAPI over HTTP/SSE — zero DB credentials.
 */

// Load .env file into process.env (minimal dotenv — no external dependency)
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Parse and apply .env file into process.env. */
function loadDotEnv(path: string, options: { overwrite?: boolean } = {}): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (# ...) unless inside quotes
    const commentIdx = val.indexOf(" #");
    if (commentIdx !== -1) {
      const before = val.slice(0, commentIdx).trim();
      if (!(before.startsWith('"') && !before.endsWith('"')) && !(before.startsWith("'") && !before.endsWith("'"))) {
        val = before;
      }
    }
    // Strip matching surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && (options.overwrite || !(key in process.env))) {
      process.env[key] = val;
    }
  }
}

const envPath = resolve(import.meta.dirname ?? process.cwd(), "../.env");
loadDotEnv(envPath); // Startup: don't overwrite existing env vars

import { createServer } from "./server/app.js";
import { loadConfig } from "./server/config.js";
import { ModelConfigStore, type CatalogValidator } from "./config/model-config-store.js";
import { DotEnvWriter } from "./config/dotenv-writer.js";
import { ModelRouter } from "./runtime/model-router.js";
import { FileWatcher } from "./config/file-watcher.js";
import { initSkillIndex, getSkillIndex } from "./skills/skill-index.js";
import { getProviderCatalogModels } from "./runtime/pi-runtime.js";

async function main() {
  const config = loadConfig();

  // Catalog validator: resolves model against Pi SDK catalog to derive capabilities
  const catalogValidator: CatalogValidator = async (provider, name) => {
    const models = await getProviderCatalogModels(provider);
    const found = models.find((m) => m.id === name || m.name === name);
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      reasoning: found.reasoning,
      input: found.input,
      contextWindow: found.contextWindow,
      maxTokens: found.maxTokens,
      thinkingLevelMap: found.thinkingLevelMap,
    };
  };

  // Initialize model config infrastructure
  const modelConfigStore = new ModelConfigStore({
    filePath: config.modelConfigsPath,
    catalogValidator,
  });
  const dotenvWriter = new DotEnvWriter({
    filePath: config.dotenvPath,
  });
  const modelRouter = new ModelRouter(modelConfigStore);

  // Shared reload function: re-read .env (with overwrite) then reload model config store
  const reloadDotEnv = async (): Promise<void> => {
    loadDotEnv(config.dotenvPath, { overwrite: true });
    await modelConfigStore.load();
  };

  // Load model configs (validates each entry, warns on invalid)
  try {
    await modelConfigStore.load();
    const validCount = modelConfigStore.list().filter((e) => e.valid).length;
    const totalCount = modelConfigStore.list().length;
    console.log(`[agent-bridge] 模型配置已加载: ${validCount}/${totalCount} 有效`);
  } catch (err) {
    console.warn(`[agent-bridge] 模型配置加载失败: ${err instanceof Error ? err.message : String(err)}，将使用空注册表`);
  }

  // Load skill index
  try {
    await initSkillIndex();
    const skillCount = getSkillIndex().size;
    console.log(`[agent-bridge] 技能索引已加载: ${skillCount} 个技能`);
  } catch (err) {
    console.warn(`[agent-bridge] 技能索引加载失败: ${err instanceof Error ? err.message : String(err)}，将使用空技能列表`);
  }

  // Start file watcher for auto-reload
  const fileWatcher = new FileWatcher({
    paths: [config.modelConfigsPath, config.dotenvPath],
    onChange: async (path) => {
      console.log(`[agent-bridge] 文件变化: ${path}，重新加载配置...`);
      try {
        await reloadDotEnv();
        const validCount = modelConfigStore.list().filter((e) => e.valid).length;
        console.log(`[agent-bridge] 配置已重新加载: ${validCount} 有效`);
      } catch (err) {
        console.error(`[agent-bridge] 配置重新加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  fileWatcher.start();

  const app = createServer(config, { modelConfigStore, dotenvWriter, modelRouter, reloadDotEnv });

  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 4000;

  app.listen(port, host, () => {
    console.log(`[agent-bridge] listening on ${host}:${port}`);
    console.log(`[agent-bridge] fastapi target: ${config.fastapiBaseUrl}`);
    const defaultModel = modelRouter.getDefault();
    console.log(`[agent-bridge] default model: ${defaultModel ? `${defaultModel.displayName} (${defaultModel.provider}:${defaultModel.name})` : "none"}`);
  });
}

main().catch((err) => {
  console.error("[agent-bridge] fatal:", err);
  process.exit(1);
});
