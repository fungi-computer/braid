import * as S from "effect/Schema";
import * as Result from "effect/Result";
import { methodOutputValues, parseProjection } from "./ports.js";
import type { Json, JsonSchemaProjection } from "./schema.js";

/** Persisted Code completion: execution refusals never select an authored outlet. */
export type CodeResult =
  | Readonly<{ kind: "complete"; ports: Readonly<Record<string, Json>> }>
  | Readonly<{ kind: "refused"; code: "invalid_output" | "result_limit" }>;

/** Validate guest JSON and project it through the declared completion grammar. */
export function codeResult(
  output: JsonSchemaProjection,
  value: unknown,
): CodeResult {
  const decoded = S.decodeUnknownResult(S.Json)(value);
  if (Result.isFailure(decoded))
    return { kind: "refused", code: "invalid_output" };
  const ports = methodOutputValues(parseProjection(output), decoded.success);
  if (ports === undefined) return { kind: "refused", code: "invalid_output" };
  const result: CodeResult = {
    kind: "complete",
    ports: { ...ports, after: true },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024)
    return { kind: "refused", code: "result_limit" };
  return result;
}
