import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { GuestThrew, type Sandbox } from "@fungi.computer/mycelium";
import { executeCode } from "../src/code-execution.js";
import { codeNodeSchema } from "../src/schema.js";

const node = S.decodeUnknownSync(codeNodeSchema)({
  id: "copy",
  kind: "code",
  source: "return await env.INPUT.read({});",
  input: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  values: { name: { literal: "Garden" } },
});

it("exposes only copied mapped JSON and forwards the host budget unchanged", async () => {
  const input = { name: "Garden" };
  const sandbox: Sandbox = {
    execute: async (request) => {
      expect(request.timeoutMs).toBe(17003);
      expect(request.executionId).toBe("run:copy:0");
      expect(request.code).toBe(node.source);
      expect(Object.keys(request.bindings)).toEqual(["INPUT"]);
      expect(Object.keys(request.bindings.INPUT ?? {})).toEqual(["read"]);
      const read = request.bindings.INPUT?.read;
      expect(read).toBeDefined();
      if (!read) throw new Error("missing input capability");
      const first = await read({});
      expect(first).toEqual(input);
      expect(first).not.toBe(input);
      expect(await read({})).not.toBe(first);
      expect(() => read({ name: "host" })).toThrow();
      return first;
    },
  };
  expect(
    await Effect.runPromise(
      executeCode({ sandbox, timeoutMs: 17003 }, node, "run:copy:0", input),
    ),
  ).toEqual({ kind: "complete", ports: { name: "Garden", after: true } });
});

it("checkpoints a closed refusal without retaining a guest exception or source", async () => {
  const sandbox: Sandbox = {
    execute: () =>
      Promise.reject(
        new GuestThrew({ name: "Error", message: "private guest data" }),
      ),
  };
  expect(
    await Effect.runPromise(
      executeCode({ sandbox, timeoutMs: 17003 }, node, "run:copy:0", {
        name: "Garden",
      }),
    ),
  ).toEqual({ kind: "refused", code: "guest_exception" });
});
