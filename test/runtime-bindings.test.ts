import { expect, it } from "vitest";
import * as runtime from "../src/runtime/index.js";
import type { WorkflowCatalogEntry } from "../src/runtime/index.js";

const definition = { apps: { prints: { appId: "app_prints" } } };
const installed = (
  installationId: string,
  appId = "app_prints",
): WorkflowCatalogEntry => ({
  installationId,
  appId,
  displayName: installationId,
  methods: {},
});

it("selects only the unique installation in the starting human's current catalog", () => {
  expect(
    runtime.resolveWorkflowBindings(definition, undefined, [
      installed("prints_current"),
      installed("other_app", "app_other"),
    ]),
  ).toEqual({ kind: "bound", bindings: { prints: "prints_current" } });
  expect(
    runtime.resolveWorkflowBindings(definition, { prints: "prints_second" }, [
      installed("prints_first"),
      installed("prints_second"),
    ]),
  ).toEqual({ kind: "bound", bindings: { prints: "prints_second" } });
});

it("returns a typed binding request for missing or ambiguous live installations", () => {
  expect(runtime.resolveWorkflowBindings(definition, undefined, [])).toEqual({
    kind: "needs-binding",
    bindings: [
      {
        name: "prints",
        appId: "app_prints",
        reason: "missing",
      },
    ],
  });
  expect(
    runtime.resolveWorkflowBindings(definition, undefined, [
      installed("prints_first"),
      installed("prints_second"),
    ]),
  ).toEqual({
    kind: "needs-binding",
    bindings: [
      {
        name: "prints",
        appId: "app_prints",
        reason: "ambiguous",
      },
    ],
  });
});

it("refuses unknown names and never accepts a foreign or wrong-App installation", () => {
  expect(
    runtime.resolveWorkflowBindings(definition, { unknown: "prints_current" }, [
      installed("prints_current"),
    ]),
  ).toMatchObject({ kind: "invalid", issues: [{ code: "binding" }] });
  for (const prints of ["prints_other_team", "other_app"]) {
    expect(
      runtime.resolveWorkflowBindings(definition, { prints }, [
        installed("prints_current"),
        installed("other_app", "app_other"),
      ]),
    ).toMatchObject({
      kind: "needs-binding",
      bindings: [{ name: "prints", reason: "missing" }],
    });
  }
});
