import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

function secretMatches(actual: string | string[] | undefined, expected: string | undefined): boolean {
  if (typeof actual !== "string" || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isEvaluationRequestAuthorized(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.APP_ENV === "evaluation"
    && secretMatches(headers["x-evaluation-nonce"], env.EVALUATION_NONCE)
    && secretMatches(headers["x-evaluation-instance-id"], env.EVALUATION_INSTANCE_ID);
}
