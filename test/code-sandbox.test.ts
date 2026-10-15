import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Sandbox, SandboxRequest } from "@fungi.computer/mycelium";
import { callCodeSandbox } from "../src/code-sandbox.js";

it("abandons an interrupted Code call even when the sandbox settles later", async () => {
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish: ((value: string) => void) | undefined;
  const backing = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  let completed = false;
  const request: SandboxRequest = {
    executionId: "run:trim:0",
    code: "return await env.INPUT.read({});",
    timeoutMs: 17003,
    bindings: { INPUT: { read: () => Promise.resolve("Garden") } },
  };
  const sandbox: Sandbox = {
    execute: async (received, signal) => {
      expect(received).toMatchObject({
        executionId: "run:trim:0",
        code: "return await env.INPUT.read({});",
        timeoutMs: 17003,
      });
      expect(Object.keys(received.bindings)).toEqual(["INPUT"]);
      observedSignal = signal;
      entered?.();
      return backing;
    },
  };
  const fiber = Effect.runFork(
    callCodeSandbox(sandbox, request).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
    ),
  );
  await started;
  // Join interruption before allowing the backing Promise to settle.
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(observedSignal?.aborted).toBe(true);
  expect(completed).toBe(false);
  finish?.("late result");
  await backing;
  expect(completed).toBe(false);
});
