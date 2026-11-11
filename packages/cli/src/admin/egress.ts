// `agentx admin egress pending | approve | reject` (Plan 2, Task 18): Rovara staff decide the domains projects (and, in Plan 3, model sources)
// ask for. On Rovara Cloud a new domain reaches the DNS firewall only after staff approve it.
import { randomUUID } from "node:crypto";
import { EgressPendingResponseSchema, agentXError, formatEgressOwner, parseEgressOwnerText, type EgressOwner, type EgressPendingResponse } from "@rovara-code/contracts";
import { sanitizeServerText } from "../auth.js";
import { adminResponseBody } from "./http.js";

/** An owner as typed: `project:<name>` or `model-source:<id>`. */
export function parseOwnerArgument(text: string): EgressOwner {
  const owner = parseEgressOwnerText(text);
  if (owner === undefined) throw agentXError("CONFIG_INVALID", "the owner is project:<name> or model-source:<id>, as `agentx admin egress pending` prints it");
  return owner;
}

const endpoint = (controlPlaneUrl: string, path: string) => `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/egress/${path}`;

export async function listPendingEgress(
  input: { controlPlaneUrl: string; accessToken: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<EgressPendingResponse> {
  const result = await adminResponseBody(await fetchImplementation(endpoint(input.controlPlaneUrl, "pending"), { headers: { authorization: `Bearer ${input.accessToken}` } }));
  const parsed = EgressPendingResponseSchema.safeParse(result);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid egress answer");
  return parsed.data;
}

export async function decideEgress(
  input: { controlPlaneUrl: string; accessToken: string; decision: "approve" | "reject"; orgId: string; owner: EgressOwner; domain: string; reason?: string; requestId?: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ orgId: string; owner: EgressOwner; domain: string; status: string; warning?: string }> {
  if (input.decision === "reject" && (input.reason === undefined || input.reason.trim() === "")) throw agentXError("CONFIG_INVALID", "say why with --reason <text>");
  const result = await adminResponseBody(await fetchImplementation(endpoint(input.controlPlaneUrl, input.decision), {
    method: "POST",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: input.requestId ?? randomUUID(), orgId: input.orgId, owner: input.owner, domain: input.domain, ...(input.decision === "reject" ? { reason: input.reason!.trim() } : {}) }),
  })) as { orgId?: unknown; domain?: unknown; status?: unknown; warning?: unknown };
  if (typeof result.orgId !== "string" || typeof result.domain !== "string" || typeof result.status !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid egress answer");
  return { orgId: result.orgId, owner: input.owner, domain: result.domain, status: result.status, ...(typeof result.warning === "string" ? { warning: result.warning } : {}) };
}

const clean = sanitizeServerText;

/** What the operator sees: one line per waiting domain, with the org, the owner, who asked and when. */
export function pendingText(response: EgressPendingResponse): string {
  if (response.pending.length === 0) return "Nothing is waiting for approval.\n";
  const lines = response.pending.map((row) => `${row.orgId}  ${clean(row.orgName)}  ${formatEgressOwner(row.owner)}  ${clean(row.domain)}  asked by ${clean(row.requestedBy.name)} at ${row.requestedAt}`);
  return `${lines.join("\n")}\n\nDecide with: agentx admin egress approve <org> <owner> <domain>, or reject <org> <owner> <domain> --reason <text>\n`;
}

export function decisionText(result: { orgId: string; owner: EgressOwner; domain: string; status: string; warning?: string }): string {
  return `${clean(result.domain)} (${formatEgressOwner(result.owner)}, ${result.orgId}) is ${result.status}.\n${result.warning === undefined ? "" : `${result.warning}\n`}`;
}
