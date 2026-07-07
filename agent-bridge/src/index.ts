/**
 * ProjectFlow Agent Bridge Sidecar
 *
 * TypeScript sidecar process that orchestrates the Agent Runtime loop.
 * Communicates with FastAPI over HTTP/SSE — zero DB credentials.
 */

// Load .env file into process.env (minimal dotenv — no external dependency)
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(import.meta.dirname ?? process.cwd(), "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
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
      // Only strip if the # is not inside a quoted string
      if (!(before.startsWith('"') && !before.endsWith('"')) && !(before.startsWith("'") && !before.endsWith("'"))) {
        val = before;
      }
    }
    // Strip matching surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

import { createServer } from "./server/app.js";
import { loadConfig } from "./server/config.js";

async function main() {
  const config = loadConfig();
  const app = createServer(config);

  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 4000;

  app.listen(port, host, () => {
    console.log(`[agent-bridge] listening on ${host}:${port}`);
    console.log(`[agent-bridge] fastapi target: ${config.fastapiBaseUrl}`);
    console.log(`[agent-bridge] model provider: ${config.defaultModelProvider}`);
  });
}

main().catch((err) => {
  console.error("[agent-bridge] fatal:", err);
  process.exit(1);
});
