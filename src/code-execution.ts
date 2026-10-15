import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import type { Sandbox } from "@fungi.computer/mycelium/sandbox";
import type { SandboxFailure } from "@fungi.computer/mycelium/sandbox-failure";
import { callCodeSandbox } from "./code-sandbox.js";
import { codeResult, type CodeResult } from "./code-result.js";
import type { CodeNode, Json } from "./schema.js";

/** Host-owned execution policy; no Workflow field can change this budget. */
export type CodeExecution = Readonly<{ sandbox: Sandbox; timeoutMs: number }>;
export type CodeFailure =
  | "invalid_source"
  | "guest_exception"
  | "deadline_exceeded"
  | "cancelled"
  | "sandbox_failed"
  | "invalid_output"
  | "result_limit";
export type CodeOutcome =
  CodeResult | Readonly<{ kind: "refused"; code: CodeFailure }>;
const emptyInput = S.Record(S.String, S.Never);
const jsonCopy = S.decodeUnknownSync(S.fromJsonString(S.MutableJson));
const failureCode = (failure: SandboxFailure): CodeFailure => {
  switch (failure._tag) {
    case "SourceInvalid":
      return "invalid_source";
    case "GuestThrew":
      return "guest_exception";
    case "DeadlineExceeded":
      return "deadline_exceeded";
    case "Cancelled":
      return "cancelled";
    case "ResultNotJson":
      return "invalid_output";
    case "ResultTooLarge":
      return "result_limit";
    case "DispatchLost":
    case "SandboxCrashed":
    case "BadResponse":
    case "CapabilityFailed":
    case "Unknown":
      return "sandbox_failed";
  }
};

/** Only mapped JSON crosses into Code; only a closed checkpoint crosses out. */
export function executeCode(
  host: CodeExecution,
  node: CodeNode,
  executionId: string,
  input: Json,
): Effect.Effect<CodeOutcome> {
  const serialized = JSON.stringify(input);
  return callCodeSandbox(host.sandbox, {
    executionId,
    code: node.source,
    timeoutMs: host.timeoutMs,
    bindings: {
      INPUT: {
        read: (request) => {
          S.decodeUnknownSync(emptyInput)(request, {
            onExcessProperty: "error",
          });
          return Promise.resolve(jsonCopy(serialized));
        },
      },
    },
  }).pipe(
    Effect.map((value) => codeResult(node.output, value)),
    Effect.catch((failure) =>
      Effect.succeed<CodeOutcome>({
        kind: "refused",
        code: failureCode(failure),
      }),
    ),
  );
}
