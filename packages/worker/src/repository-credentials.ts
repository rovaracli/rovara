import { WORKER_CREDENTIAL_KINDS_HEADER, agentXError, type GitCredentialKind, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";

/**
 * The credential kinds this worker takes beyond a token and a password (P8), listed by hand: the broker is told in a header and sends only these. `helper` is not here: no worker runs a
 * credential helper yet, so the broker never sends one. A kind added here is added to WORKER_IMPLEMENTED_FEATURES' `repository.credentialKinds.v1` meaning, and implemented in git-auth.ts.
 */
export const WORKER_TAKEN_CREDENTIAL_KINDS: readonly GitCredentialKind[] = ["token", "basic", "ssh-key"];

export interface RepositoryCloneCredential {
  username?: string;
  password?: string;
  token?: string;
  /** An ssh key (P8): used for the repository's https address `forUrl` through `url`, with the pinned `knownHosts`. Never put in a process's environment. */
  ssh?: { privateKey: string; url: string; knownHosts: string; forUrl: string };
}

export type RepositoryCredentialProvider = (
  repository: ProjectDefinition["repositories"][number],
) => Promise<RepositoryCloneCredential>;

type RepositoryCredentialInvocation = Extract<WorkerInvocation, { kind: "prepare" | "publish" | "maintain" }>;

export function createRepositoryCredentialProvider(input: {
  controlPlaneUrl: string;
  invocation: RepositoryCredentialInvocation;
  fetchImplementation?: typeof fetch;
}): RepositoryCredentialProvider {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const base = input.controlPlaneUrl.replace(/\/$/, "");
  const endpoint = `${base}/v1/internal/workspaces/${input.invocation.workspaceId}/operations/${input.invocation.operationId}/repository-credentials`;
  return async (repository) => {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentx-repository-grant": input.invocation.payload.repositoryGrant,
        // P8: which credential kinds this worker takes. A broker that predates it ignores the header and sends the legacy two.
        [WORKER_CREDENTIAL_KINDS_HEADER]: WORKER_TAKEN_CREDENTIAL_KINDS.join(","),
      },
      body: JSON.stringify({
        credentialRef: repository.credentialRef,
        repositoryUrl: repository.url,
        access: input.invocation.kind === "prepare" ? "clone" : "push",
      }),
    });
    if (!response.ok) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        `repository credential exchange failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("credential" in body)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "repository credential response is invalid");
    }
    return parseCredential(body.credential, repository.url);
  };
}

function parseCredential(value: unknown, repositoryUrl: string): RepositoryCloneCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential is invalid");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["username", "password", "token", "ssh"].includes(key))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains unsupported fields");
  }
  if (input.ssh !== undefined) {
    // An ssh key stands alone: next to a password or token it is a credential nobody asked for.
    if (Object.keys(input).length !== 1) throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains unsupported fields");
    return { ssh: { ...parseSsh(input.ssh), forUrl: repositoryUrl } };
  }
  const result: RepositoryCloneCredential = {};
  for (const key of ["username", "password", "token"] as const) {
    const entry = input[key];
    if (entry !== undefined) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 8_192) {
        throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains an invalid value");
      }
      result[key] = entry;
    }
  }
  return result;
}

function parseSsh(value: unknown): { privateKey: string; url: string; knownHosts: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw agentXError("RUNTIME_UNAVAILABLE", "repository credential is invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["privateKey", "url", "knownHosts"].includes(key))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains unsupported fields");
  }
  const { privateKey, url, knownHosts } = input;
  if (typeof privateKey !== "string" || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(privateKey) || privateKey.length > 16_384
    || typeof url !== "string" || !/^ssh:\/\/[A-Za-z0-9._@:/~+-]{1,512}$/u.test(url)
    || typeof knownHosts !== "string" || knownHosts.trim() === "" || knownHosts.length > 8_192) {
    throw agentXError("RUNTIME_UNAVAILABLE", "repository credential contains an invalid value");
  }
  return { privateKey, url, knownHosts };
}
