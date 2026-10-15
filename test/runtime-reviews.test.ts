import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { compile } from "../src/index.js";
import { createGraphWorkflowRuns } from "../src/runtime/index.js";

it("retains a review and its admitted answer across shared owner recreation", async () => {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Saved review",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          id: "look",
          kind: "review",
          title: "Keep it?",
          show: [],
          reviewers: "runner",
          timeout: 60000,
        },
      ],
      edges: [],
      output: { item: { node: "look", port: "approved" } },
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const runs = createGraphWorkflowRuns(owner);
    expect(
      runs.startCompiled({
        teamId: "team",
        runId: "run",
        requestId: "request",
        actorId: "member",
        computerId: null,
        plan: compiled.plan,
        input: {},
        ceiling: { nodes: [], nodeGitAccess: [] },
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member" },
      }),
    ).toBe("started");
    const review = {
      runId: "run",
      nodeId: "look",
      iteration: "0",
      instanceId: "run",
      eventType: "review_native",
      title: "Keep it?",
      reviewers: "runner" as const,
      timeout: 60000,
      show: [],
    };
    const beforeOpen = Date.now();
    const expiresAt = runs.openReview(review);
    expect(runs.reviews("run")[0]?.openedAt).toBeGreaterThanOrEqual(beforeOpen);
    expect(runs.reviews("run")[0]?.expiresAt).toBe(expiresAt);
    const reopened = createGraphWorkflowRuns(owner);
    expect(reopened.openReview(review)).toBe(expiresAt);
    expect(reopened.reviews("run")).toEqual([
      {
        review,
        status: "pending",
        openedAt: expiresAt - review.timeout,
        expiresAt,
      },
    ]);
    expect(
      reopened.answerReview(
        review,
        { approved: true },
        { kind: "agent", actorId: "member", isOwner: true },
      ),
    ).toBe("denied");
    expect(
      reopened.answerReview(
        review,
        { approved: true },
        { kind: "member", actorId: "foreign", isOwner: false },
      ),
    ).toBe("denied");
    expect(
      reopened.answerReview(
        review,
        { approved: true },
        { kind: "member", actorId: "member", isOwner: false },
      ),
    ).toBe("accepted");
    const restored = createGraphWorkflowRuns(owner);
    expect(restored.pendingReviewDeliveries("run")).toEqual([
      {
        runId: "run",
        nodeId: "look",
        iteration: "0",
        instanceId: "run",
        eventType: "review_native",
        answer: { approved: true },
      },
    ]);
    expect(
      restored.answerReview(
        review,
        { approved: false },
        { kind: "member", actorId: "member", isOwner: false },
      ),
    ).toBe("not_waiting");
    const beforeDecision = Date.now();
    restored.recordEvent({
      runId: "run",
      nodeId: "look",
      iteration: "0",
      attempt: 0,
      state: "complete",
      output: { approved: true, choice: "approved", note: "" },
    });
    const recorded = createGraphWorkflowRuns(owner).events("run")[0];
    expect(recorded?.output).toEqual({
      approved: true,
      choice: "approved",
      note: "",
    });
    expect(recorded?.recordedAt).toBeTypeOf("number");
    expect(recorded?.recordedAt).toBeGreaterThanOrEqual(beforeDecision);
    restored.markTerminal("run", "cancelled");
    expect(restored.pendingReviewDeliveries("run")).toEqual([]);
    expect(restored.reviews("run")[0]?.status).toBe("closed");
    expect(() => {
      restored.recordEvent({
        runId: "run",
        nodeId: "look",
        iteration: "0",
        state: "running",
        attempt: 0,
      });
    }).toThrow("not active");
    expect(() => restored.openReview(review)).toThrow("not active");
  } finally {
    database.close();
  }
});
