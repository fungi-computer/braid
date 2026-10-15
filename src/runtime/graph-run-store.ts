import * as S from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { admitRunInput, decodeExecutionPlan, canonicalJson } from "../index.js";
import { graphRunSchema, type GraphRun } from "./graph-contract.js";
import {
  nodeEventSchema,
  graphReviewSchema,
  reviewAnswerSchema,
  type NodeEvent,
  type GraphReview,
} from "../index.js";
const rowSchema = S.Struct({ record: S.String });
const deliverySchema = S.Struct({
  runId: S.String,
  nodeId: S.String,
  iteration: S.String,
  instanceId: S.String,
  eventType: S.String,
  answer: reviewAnswerSchema,
});
export type ReviewDelivery = typeof deliverySchema.Type;
export type GraphReviewer = {
  readonly kind: "member" | "agent";
  readonly actorId: string;
  readonly isOwner: boolean;
};
/** The durable state of every Workflow run: runs, node events, reviews and outcomes. */
export function createGraphWorkflowRuns(options: {
  sql: WatchdogSqliteOwner["sql"];
  transactionSync: <T>(body: () => T) => T;
}) {
  const { sql } = options;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hub_graph_runs (run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,installation_id TEXT,workflow_id TEXT,actor_id TEXT NOT NULL,started_at INTEGER NOT NULL,record TEXT NOT NULL) STRICT`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS hub_graph_runs_listing ON hub_graph_runs(installation_id, actor_id, started_at DESC, run_id DESC)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hub_graph_terminal_runs (run_id TEXT PRIMARY KEY REFERENCES hub_graph_runs(run_id), outcome TEXT NOT NULL CHECK(outcome IN ('terminal','cancelled'))) STRICT`,
  );
  // The decoder forbids empty named graph ids; the empty SQL key names only the root.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hub_graph_node_events (run_id TEXT NOT NULL,graph_id TEXT NOT NULL,node_id TEXT NOT NULL,iteration TEXT NOT NULL,poll INTEGER NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(run_id,graph_id,node_id,iteration,poll,state,attempt)) STRICT`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS workflow_graph_reviews (run_id TEXT NOT NULL,node_id TEXT NOT NULL,iteration TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','answered','delivered','timed_out','closed')),record TEXT NOT NULL,delivery TEXT,opened_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(run_id,node_id,iteration)) STRICT`,
  );
  const read = (runId: string): GraphRun | null => {
    const row = sql
      .exec("SELECT record FROM hub_graph_runs WHERE run_id=?", runId)
      .toArray()[0];
    return row === undefined
      ? null
      : S.decodeUnknownSync(graphRunSchema)(
          JSON.parse(S.decodeUnknownSync(rowSchema)(row).record),
        );
  };
  const requireRun = (runId: string): GraphRun => {
    const run = read(runId);
    if (!run) throw new Error("Unknown graph run");
    return run;
  };
  const requireActive = (runId: string) => {
    const run = read(runId);
    if (
      run === null ||
      sql
        .exec(
          "SELECT run_id FROM hub_graph_terminal_runs WHERE run_id=?",
          runId,
        )
        .toArray().length !== 0
    )
      throw new Error("Workflow run is not active");
    return run;
  };
  /** Only the Team run owner supplies already compiled, stored plans here. */
  const startCompiled = (
    input: GraphRun,
  ): "started" | "replay" | "conflict" => {
    const decoded = S.decodeUnknownSync(graphRunSchema)(input, {
      onExcessProperty: "error",
    });
    const admitted = admitRunInput(decoded.plan.definition, decoded.input);
    if (admitted.kind === "invalid") throw new Error("Invalid graph run input");
    const run = { ...decoded, input: admitted.input };
    return options.transactionSync(() => {
      const row = sql
        .exec(
          "SELECT record FROM hub_graph_runs WHERE request_id=? OR run_id=?",
          run.requestId,
          run.runId,
        )
        .toArray()[0];
      if (row !== undefined) {
        const prior = S.decodeUnknownSync(graphRunSchema)(
          JSON.parse(S.decodeUnknownSync(rowSchema)(row).record),
        );
        return canonicalJson(prior) === canonicalJson(run)
          ? "replay"
          : "conflict";
      }
      sql.exec(
        "INSERT INTO hub_graph_runs(run_id,request_id,installation_id,workflow_id,actor_id,started_at,record) VALUES(?,?,?,?,?,?,?)",
        run.runId,
        run.requestId,
        run.publication?.installationId ??
          run.libraryInstallationId ??
          run.trigger?.libraryInstallationId ??
          null,
        run.publication?.workflowId ?? run.trigger?.workflowId ?? null,
        run.actorId,
        Date.now(),
        JSON.stringify(run),
      );
      return "started";
    });
  };
  return {
    read,
    /**
     * Up to 50 runs for one installation, newest first; a viewer narrows
     * further to their own. `started_at` is the host clock at insert, kept
     * out of the record so a replay still compares equal.
     */
    list(filter: {
      installationId: string;
      actorId?: string;
      workflowId?: string;
    }): readonly (GraphRun & { startedAt: number })[] {
      const conditions = ["installation_id=?"];
      const params: string[] = [filter.installationId];
      if (filter.actorId !== undefined) {
        conditions.push("actor_id=?");
        params.push(filter.actorId);
      }
      if (filter.workflowId !== undefined) {
        conditions.push("workflow_id=?");
        params.push(filter.workflowId);
      }
      return sql
        .exec(
          `SELECT record,started_at FROM hub_graph_runs WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC, run_id DESC LIMIT 50`,
          ...params,
        )
        .toArray()
        .map((row) => {
          const parsed = S.decodeUnknownSync(
            S.Struct({ record: S.String, started_at: S.Number }),
          )(row);
          return {
            ...S.decodeUnknownSync(graphRunSchema)(JSON.parse(parsed.record)),
            startedAt: parsed.started_at,
          };
        });
    },
    /** Runs with no recorded outcome, oldest first. */
    active(): readonly GraphRun[] {
      return sql
        .exec(
          "SELECT record FROM hub_graph_runs WHERE run_id NOT IN (SELECT run_id FROM hub_graph_terminal_runs) ORDER BY rowid",
        )
        .toArray()
        .map((row) =>
          S.decodeUnknownSync(graphRunSchema)(
            JSON.parse(S.decodeUnknownSync(rowSchema)(row).record),
          ),
        );
    },
    outcome(runId: string): "active" | "terminal" | "cancelled" | null {
      if (read(runId) === null) return null;
      const row = sql
        .exec(
          "SELECT outcome FROM hub_graph_terminal_runs WHERE run_id=?",
          runId,
        )
        .toArray()[0];
      return row === undefined
        ? "active"
        : S.decodeUnknownSync(
            S.Struct({ outcome: S.Literals(["terminal", "cancelled"]) }),
          )(row).outcome;
    },
    markTerminal(
      runId: string,
      outcome: "terminal" | "cancelled" = "terminal",
    ): void {
      requireRun(runId);
      options.transactionSync(() => {
        sql.exec(
          "INSERT OR IGNORE INTO hub_graph_terminal_runs(run_id,outcome) VALUES(?,?)",
          runId,
          outcome,
        );
        sql.exec(
          "UPDATE workflow_graph_reviews SET status='closed',delivery=NULL WHERE run_id=? AND status IN ('pending','answered')",
          runId,
        );
      });
    },
    startCompiled,
    async start(input: GraphRun): Promise<"started" | "replay" | "conflict"> {
      const run = S.decodeUnknownSync(graphRunSchema)(input, {
        onExcessProperty: "error",
      });
      await decodeExecutionPlan(run.plan);
      return startCompiled(run);
    },
    recordEvent(input: NodeEvent): void {
      const event = S.decodeUnknownSync(nodeEventSchema)(input, {
        onExcessProperty: "error",
      });
      requireActive(event.runId);
      options.transactionSync(() => {
        const prior = sql
          .exec(
            "SELECT record FROM hub_graph_node_events WHERE run_id=? AND graph_id=? AND node_id=? AND iteration=? AND poll=? AND state=? AND attempt=?",
            event.runId,
            event.graphId ?? "",
            event.nodeId,
            event.iteration,
            event.poll ?? -1,
            event.state,
            event.attempt,
          )
          .toArray()[0];
        if (prior !== undefined) return;
        const count = S.decodeUnknownSync(S.Struct({ count: S.Number }))(
          sql
            .exec(
              "SELECT count(*) AS count FROM hub_graph_node_events WHERE run_id=?",
              event.runId,
            )
            .toArray()[0],
        ).count;
        if (count >= 4096) throw new Error("Graph event bound exceeded");
        sql.exec(
          "INSERT OR IGNORE INTO hub_graph_node_events(run_id,graph_id,node_id,iteration,poll,state,attempt,record) VALUES(?,?,?,?,?,?,?,?)",
          event.runId,
          event.graphId ?? "",
          event.nodeId,
          event.iteration,
          event.poll ?? -1,
          event.state,
          event.attempt,
          JSON.stringify({ ...event, recordedAt: Date.now() }),
        );
        if (event.state === "failed" && event.refusal === "review_timeout")
          sql.exec(
            "UPDATE workflow_graph_reviews SET status='timed_out' WHERE run_id=? AND node_id=? AND iteration=? AND status IN ('pending','answered')",
            event.runId,
            event.nodeId,
            event.iteration,
          );
      });
    },
    events(runId: string): readonly NodeEvent[] {
      requireRun(runId);
      return sql
        .exec(
          "SELECT record FROM hub_graph_node_events WHERE run_id=? ORDER BY rowid",
          runId,
        )
        .toArray()
        .map((row) =>
          S.decodeUnknownSync(nodeEventSchema)(
            JSON.parse(S.decodeUnknownSync(rowSchema)(row).record),
          ),
        );
    },
    openReview(input: GraphReview): number {
      const review = S.decodeUnknownSync(graphReviewSchema)(input, {
        onExcessProperty: "error",
      });
      requireActive(review.runId);
      return options.transactionSync(() => {
        const row = sql
          .exec(
            "SELECT record,expires_at FROM workflow_graph_reviews WHERE run_id=? AND node_id=? AND iteration=?",
            review.runId,
            review.nodeId,
            review.iteration,
          )
          .toArray()[0];
        if (row !== undefined) {
          const stored = S.decodeUnknownSync(
            S.Struct({ record: S.String, expires_at: S.Number }),
          )(row);
          if (stored.record !== JSON.stringify(review))
            throw new Error("Conflicting graph review");
          return stored.expires_at;
        }
        const openedAt = Date.now();
        const expiresAt = openedAt + review.timeout;
        sql.exec(
          "INSERT INTO workflow_graph_reviews(run_id,node_id,iteration,status,record,opened_at,expires_at) VALUES(?,?,?,'pending',?,?,?)",
          review.runId,
          review.nodeId,
          review.iteration,
          JSON.stringify(review),
          openedAt,
          expiresAt,
        );
        return expiresAt;
      });
    },
    reviews(runId: string) {
      requireRun(runId);
      return sql
        .exec(
          "SELECT record,status,opened_at,expires_at FROM workflow_graph_reviews WHERE run_id=? ORDER BY rowid",
          runId,
        )
        .toArray()
        .map((row) => {
          const parsed = S.decodeUnknownSync(
            S.Struct({
              record: S.String,
              status: S.Literals([
                "pending",
                "answered",
                "delivered",
                "timed_out",
                "closed",
              ]),
              opened_at: S.Number,
              expires_at: S.Number,
            }),
          )(row);
          return {
            review: S.decodeUnknownSync(graphReviewSchema)(
              JSON.parse(parsed.record),
            ),
            status: parsed.status,
            openedAt: parsed.opened_at,
            expiresAt: parsed.expires_at,
          };
        });
    },
    answerReview(
      key: Pick<GraphReview, "runId" | "nodeId" | "iteration">,
      answer: typeof reviewAnswerSchema.Type,
      reviewer: GraphReviewer,
    ): "accepted" | "denied" | "not_waiting" | "invalid" {
      const run = requireRun(key.runId);
      if (
        sql
          .exec(
            "SELECT run_id FROM hub_graph_terminal_runs WHERE run_id=?",
            key.runId,
          )
          .toArray().length !== 0
      )
        return "not_waiting";
      const checked = S.decodeUnknownSync(reviewAnswerSchema)(answer, {
        onExcessProperty: "error",
      });
      return options.transactionSync(() => {
        const row = sql
          .exec(
            "SELECT record,status,expires_at FROM workflow_graph_reviews WHERE run_id=? AND node_id=? AND iteration=?",
            key.runId,
            key.nodeId,
            key.iteration,
          )
          .toArray()[0];
        if (row === undefined) return "not_waiting";
        const parsed = S.decodeUnknownSync(
          S.Struct({
            record: S.String,
            status: S.String,
            expires_at: S.Number,
          }),
        )(row);
        const review = S.decodeUnknownSync(graphReviewSchema)(
          JSON.parse(parsed.record),
        );
        if (
          reviewer.kind === "agent" ||
          (!reviewer.isOwner &&
            (review.reviewers === "owners" || reviewer.actorId !== run.actorId))
        )
          return "denied";
        if (parsed.status !== "pending") return "not_waiting";
        if (Date.now() >= parsed.expires_at) {
          sql.exec(
            "UPDATE workflow_graph_reviews SET status='timed_out' WHERE run_id=? AND node_id=? AND iteration=? AND status='pending'",
            key.runId,
            key.nodeId,
            key.iteration,
          );
          return "not_waiting";
        }
        // The answer must fit the review: a choice it offers, or approve/reject.
        if (
          "choice" in checked
            ? !review.choices?.includes(checked.choice)
            : review.choices !== undefined
        )
          return "invalid";
        const delivery: ReviewDelivery = {
          ...key,
          instanceId: review.instanceId,
          eventType: review.eventType,
          answer: checked,
        };
        sql.exec(
          "UPDATE workflow_graph_reviews SET status='answered',delivery=? WHERE run_id=? AND node_id=? AND iteration=? AND status='pending'",
          JSON.stringify(delivery),
          key.runId,
          key.nodeId,
          key.iteration,
        );
        return "accepted";
      });
    },
    /** Durable pending delivery survives a sender restart; native event sends may be repeated. */
    pendingReviewDeliveries(runId: string): readonly ReviewDelivery[] {
      requireRun(runId);
      return sql
        .exec(
          "SELECT delivery FROM workflow_graph_reviews WHERE run_id=? AND status='answered'",
          runId,
        )
        .toArray()
        .map((row) =>
          S.decodeUnknownSync(deliverySchema)(
            JSON.parse(
              S.decodeUnknownSync(S.Struct({ delivery: S.String }))(row)
                .delivery,
            ),
          ),
        );
    },
    markReviewDelivered(delivery: ReviewDelivery): void {
      sql.exec(
        "UPDATE workflow_graph_reviews SET status='delivered' WHERE run_id=? AND node_id=? AND iteration=? AND status='answered'",
        delivery.runId,
        delivery.nodeId,
        delivery.iteration,
      );
    },
  };
}
