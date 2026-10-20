// `agentx admin org github-owner set` (ruling R55): an operator names the one GitHub account or organization whose repositories an
// owner or admin of a cloud org may register as projects. The shared GitHub App sees many repositories, so visibility alone must not decide.
import { agentXError } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

export async function setOrgGithubOwner(
  input: { controlPlaneUrl: string; accessToken: string; orgId: string; githubOwner: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ org: { orgId: string; githubOwner: string } }> {
  const result = await adminResponseBody(await fetchImplementation(`${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/org/github-owner`, {
    method: "PUT",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId: input.orgId, githubOwner: input.githubOwner }),
  })) as { org?: { orgId?: unknown; githubOwner?: unknown } };
  if (typeof result.org?.orgId !== "string" || typeof result.org.githubOwner !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid github-owner answer");
  }
  return { org: { orgId: result.org.orgId, githubOwner: result.org.githubOwner } };
}

/** What the operator is told. */
export function githubOwnerText(org: { orgId: string; githubOwner: string }): string {
  return `Organization ${org.orgId} may now create projects for repositories under the GitHub owner ${org.githubOwner}.\n`;
}
