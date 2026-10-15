import * as S from "effect/Schema";

/** How a run ended, as its host reports it; decoded where it crosses a door. */
export const workflowRunEndingSchema = S.Union([
  S.Struct({ kind: S.Literal("complete"), output: S.Json }),
  S.Struct({ kind: S.Literal("failed"), error: S.String }),
  S.Struct({ kind: S.Literal("cancelled") }),
]);
export type WorkflowRunEnding = typeof workflowRunEndingSchema.Type;

/** A Session message stays readable; the full output remains in runStatus. */
const OUTPUT_PREVIEW_CHARS = 2_000;
const ERROR_CHARS = 500;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/** The follow-up the run's declared delivery Session receives, on every host. */
export function workflowRunReport(
  title: string,
  runId: string,
  ending: WorkflowRunEnding,
): string {
  const name = `Workflow "${title}" (run ${runId})`;
  switch (ending.kind) {
    case "complete":
      return `${name} finished.\nResult:\n${clip(
        JSON.stringify(ending.output, null, 2),
        OUTPUT_PREVIEW_CHARS,
      )}`;
    case "failed":
      return `${name} failed: ${clip(ending.error, ERROR_CHARS)}`;
    case "cancelled":
      return `${name} was cancelled.`;
  }
}
