type IdReplacement = { id: string; label: string };

const INTERNAL_ID_PATTERN =
  /\b(?:user|task|stage|proj(?:ect)?|workspace|conversation)-[A-Za-z0-9_-]+\b/gi;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function collectIdReplacements(value: unknown, result: IdReplacement[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIdReplacements(item, result);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const label = [record.display_name, record.title, record.name].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  for (const key of ["user_id", "task_id", "stage_id", "project_id", "workspace_id", "id"]) {
    const id = record[key];
    if (label && typeof id === "string" && id !== label) {
      result.push({ id, label });
    }
  }

  for (const child of Object.values(record)) collectIdReplacements(child, result);
}

function replacementsFor(workspaceState: unknown): IdReplacement[] {
  const replacements: IdReplacement[] = [];
  collectIdReplacements(workspaceState, replacements);
  return [...new Map(replacements.map((item) => [item.id, item])).values()].sort(
    (left, right) => right.id.length - left.id.length,
  );
}

export function sanitizeModelOutput(output: string, workspaceState: unknown): string {
  let sanitized = output;
  for (const { id, label } of replacementsFor(workspaceState)) {
    sanitized = sanitized.split(id).join(label);
  }
  return sanitized
    .replace(INTERNAL_ID_PATTERN, "[内部引用]")
    .replace(UUID_PATTERN, "[内部引用]");
}

export interface OutputSanitizer {
  push(chunk: string): string;
  flush(): string;
  sanitize(output: string): string;
}

export function createOutputSanitizer(workspaceState: unknown): OutputSanitizer {
  let pending = "";
  const minimumTail = 80;

  return {
    push(chunk: string): string {
      pending += chunk;
      if (pending.length <= minimumTail * 2) return "";

      const searchEnd = pending.length - minimumTail;
      const prefix = pending.slice(0, searchEnd);
      const boundary = Math.max(
        prefix.lastIndexOf(" "),
        prefix.lastIndexOf("\n"),
        prefix.lastIndexOf("。"),
        prefix.lastIndexOf("，"),
        prefix.lastIndexOf("；"),
      );
      if (boundary < 0) return "";

      const complete = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      return sanitizeModelOutput(complete, workspaceState);
    },
    flush(): string {
      const complete = sanitizeModelOutput(pending, workspaceState);
      pending = "";
      return complete;
    },
    sanitize(output: string): string {
      return sanitizeModelOutput(output, workspaceState);
    },
  };
}
