// SH25 (review M1): the worker's request for the saved environment pull login. The prepare invocation carries no credential (an invocation is stored); the worker presents the preparation's own grant right before the
// pull and the broker decides whether the preparation is still running and which image it may pull (test-env/saved-env-login.ts). Nothing but a fixed sentence leaves this file on a failure, and the login is returned
// to the caller only: it is never logged or written here.
import { SAVED_ENV_LOGIN_PATH, SavedEnvRegistryAuthSchema, agentXError, type SavedEnvRegistryAuth, type WorkerInvocation } from "@agentx/contracts";

export type SavedEnvLoginProvider = () => Promise<SavedEnvRegistryAuth>;

export function createSavedEnvLoginProvider(input: {
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  fetchImplementation?: typeof fetch;
}): SavedEnvLoginProvider {
  const send = input.fetchImplementation ?? fetch;
  const endpoint = `${input.controlPlaneUrl.replace(/\/$/, "")}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/${SAVED_ENV_LOGIN_PATH}`;
  return async () => {
    const unavailable = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not get a login for the saved environment"); };
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentx-repository-grant": input.invocation.payload.repositoryGrant },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
    } catch { return unavailable(); }
    if (!response.ok) return unavailable();
    let body: unknown;
    try { body = await response.json(); } catch { return unavailable(); }
    const parsed = SavedEnvRegistryAuthSchema.safeParse(typeof body === "object" && body !== null && "login" in body ? body.login : undefined);
    return parsed.success ? parsed.data : unavailable();
  };
}
