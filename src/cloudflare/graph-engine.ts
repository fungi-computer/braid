import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import * as S from "effect/Schema";
import type { CodeExecution } from "../code-execution.js";
import {
  graphParamsSchema,
  type NodeDispatcher,
  type GraphParams,
} from "../execution.js";
import type { Json } from "../schema.js";
import { runGraphWorkflow } from "./graph-program.js";
export type GraphWorkflowBindings = { GRAPH_WORKFLOWS: Workflow<GraphParams> };
/** How a root run ended, as the engine observed it; hosts may report it. */
export type GraphRunEnding =
  | Readonly<{ kind: "complete"; output: Readonly<Record<string, Json>> }>
  | Readonly<{ kind: "failed"; error: string }>;
/** Each host supplies App dispatch, run storage, and terminal cleanup. */
export abstract class GraphWorkflow<
  Env extends GraphWorkflowBindings = GraphWorkflowBindings,
> extends WorkflowEntrypoint<Env, GraphParams> {
  /** The host scope and run identity select the owner receiving execution facts. */
  protected abstract dispatcher(params: GraphParams): NodeDispatcher;
  protected abstract terminalTriggerRun(
    params: GraphParams,
    ending: GraphRunEnding,
  ): Promise<void>;
  /** A host may admit data-only Code with its own sandbox and captured budget. */
  protected codeExecution(): CodeExecution | undefined {
    return undefined;
  }
  override async run(
    event: Readonly<WorkflowEvent<GraphParams>>,
    step: WorkflowStep,
  ) {
    const params = S.decodeUnknownSync(graphParamsSchema)(event.payload, {
      onExcessProperty: "error",
    });
    let output;
    try {
      output = await runGraphWorkflow(
        step,
        params,
        event.instanceId,
        this.env.GRAPH_WORKFLOWS,
        this.dispatcher(params),
        this.codeExecution(),
      );
    } catch (cause) {
      if (params.kind === "map-item")
        await step.do("notify-parent-failed", async () => {
          const parent = await this.env.GRAPH_WORKFLOWS.get(
            params.parentInstanceId,
          );
          await parent.sendEvent({
            type: params.completionEvent,
            payload: { refusal: "map_item_failed" },
          });
          return null;
        });
      if (params.kind === "run" && params.runId === event.instanceId)
        await step.do("terminal-trigger-run", async () => {
          await this.terminalTriggerRun(params, {
            kind: "failed",
            error: cause instanceof Error ? cause.message : "failed",
          });
          return null;
        });
      throw cause;
    }
    if (params.kind === "run")
      await step.do("terminal-trigger-run", async () => {
        await this.terminalTriggerRun(params, { kind: "complete", output });
        return null;
      });
    return output;
  }
}
