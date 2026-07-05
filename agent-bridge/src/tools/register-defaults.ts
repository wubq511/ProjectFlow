/**
 * Register default ProjectFlow tools into the ToolRegistry.
 * Called during run initialization before executeRun().
 */

import type { FastapiClient } from "./fastapi-client.js";
import type { ToolRegistry } from "./registry.js";
import { createDefaultProjectFlowTools } from "./projectflow-tools.js";

/**
 * Register all default ProjectFlow tools into the registry.
 */
export function registerDefaultTools(registry: ToolRegistry, fastapiClient: FastapiClient): void {
  for (const tool of createDefaultProjectFlowTools(fastapiClient)) {
    registry.register(tool);
  }
}
