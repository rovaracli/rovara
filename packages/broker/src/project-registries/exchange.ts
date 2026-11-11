// N9 (INTG2): the exchange the worker calls at `prepare` (POST .../operations/<id>/registry-credentials). The worker names a registry; the broker decides everything else:
//   - the request must carry the operation's repository grant (signed, bound to this workspace and operation, short-lived);
//   - the operation must be this workspace's ACTIVE PREPARE: no other kind of operation (a task, a publication) ever receives a registry token, and neither does a prepare that is over;
//   - the registry is looked up in the project revision the workspace is pinned to, never taken from the request, so a worker cannot ask for a domain the project did not name;
//   - the install switch, the edition, the org's binding of the CodeArtifact domain (another org's domain gets no token) and the project's approved websites are checked again here (they may have changed since the invocation was built);
//   - the token is minted for that one registry, read-only by the broker's identity, and is not logged: the audit line names the registry and the expiry only.
import { REGISTRY_PROBLEM_MESSAGES, RegistryCredentialRequestSchema, agentXError, registryProblems, type BoundRegistryDomain, type Edition, type ProjectRegistry, type RegistryCredential } from "@rovara-code/contracts";
import { mintRegistryCredential, type RegistryTokenSource } from "./mint.js";

export const REGISTRIES_OFF_MESSAGE = "Package registries are not switched on for this install.";

export interface RegistryExchangeContext {
  enabled: boolean;
  edition: Edition | undefined;
  /** The CodeArtifact domains the install bound to an org: a registry naming another org's domain gets no token. */
  boundDomains: readonly BoundRegistryDomain[];
  source: RegistryTokenSource;
  /** Verifies the grant's signature and expiry and returns what it is bound to. Throws FORBIDDEN. */
  inspectGrant(grant: string): { workspaceId: string; operationId: string };
  /** The operation and its workspace, as stored. */
  readOperation(workspaceId: string, operationId: string): Promise<{ kind: string; status: string; workspace: { status: string; activeOperationId: string | null | undefined } }>;
  /** The registries and approved websites of the project revision the workspace is pinned to, and the org the workspace belongs to. */
  readProject(workspaceId: string): Promise<{ registries: readonly ProjectRegistry[]; allowedDomains: readonly string[]; orgId: string | undefined }>;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const LIVE_STATUSES = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export async function exchangeRegistryCredentialCore(context: RegistryExchangeContext, input: { grant: string | undefined; workspaceId: string; operationId: string; body: unknown }): Promise<{ credential: RegistryCredential }> {
  if (!context.enabled) throw agentXError("FORBIDDEN", REGISTRIES_OFF_MESSAGE);
  if (!input.grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const request = RegistryCredentialRequestSchema.safeParse(input.body);
  if (!request.success) throw agentXError("CONFIG_INVALID", "registry credential request is invalid");
  const claims = context.inspectGrant(input.grant);
  if (claims.workspaceId !== input.workspaceId || claims.operationId !== input.operationId) throw agentXError("FORBIDDEN", "registry credential grant does not cover this request");
  const operation = await context.readOperation(input.workspaceId, input.operationId);
  if (operation.kind !== "prepare" || !LIVE_STATUSES.has(operation.status) || operation.workspace.status !== "PREPARING" || operation.workspace.activeOperationId !== input.operationId) {
    throw agentXError("FORBIDDEN", "registry credentials are given to a running preparation only");
  }
  const project = await context.readProject(input.workspaceId);
  const entry = project.registries.find((candidate) => candidate.name === request.data.registry);
  if (entry === undefined) throw agentXError("FORBIDDEN", "registry credential grant does not cover this request");
  const problem = registryProblems({ edition: context.edition, registries: [entry], allowedDomains: project.allowedDomains, orgId: project.orgId, boundDomains: context.boundDomains })[0];
  if (problem !== undefined) throw agentXError("FORBIDDEN", REGISTRY_PROBLEM_MESSAGES[problem.code]);
  const now = context.now ?? (() => new Date());
  const credential = await mintRegistryCredential(entry, context.source, now);
  // The line names the registry and the expiry; the token and the credential reference are never in it.
  (context.log ?? ((event) => { console.log(JSON.stringify({ component: "broker", ...event })); }))({ event: "registry.credential_issued", registry: entry.name, kind: entry.kind, workspaceId: input.workspaceId, operationId: input.operationId, expiresAt: credential.expiresAt });
  return { credential };
}
