import * as Effect from "effect/Effect";
import type {
  Sandbox,
  SandboxRequest,
  SandboxValue,
} from "@fungi.computer/mycelium/sandbox";
import type { SandboxFailure } from "@fungi.computer/mycelium/sandbox-failure";
import { sandboxFailure } from "@fungi.computer/mycelium/sandbox-boundary";

/**
 * A Code step abandons its call when its owning Effect is interrupted. The
 * sandbox receives Effect's local abort signal; trusted host budgets remain
 * responsible for backing work that cannot acknowledge cancellation.
 */
export function callCodeSandbox(
  sandbox: Sandbox,
  request: SandboxRequest,
): Effect.Effect<SandboxValue, SandboxFailure> {
  return Effect.tryPromise({
    try: (signal) => sandbox.execute(request, signal),
    catch: sandboxFailure,
  });
}
