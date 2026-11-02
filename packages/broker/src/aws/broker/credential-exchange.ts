// Enterprise foundations N-3 (wiring): the credential the broker hands a worker at `/repository-credentials` comes from the repository's code host (the port's
// `issueGitCredential`) and is held to `workerGitCredentialUsable` first: it must parse, not be expired, not outlive an hour, and an ssh key goes only to a service
// identity. A credential that fails is refused with a fixed sentence and the worker gets nothing.
//
// The worker's wire shape stays `{username, password}` or `{token}` for the two legacy kinds (an older worker refuses any other field). An ssh key goes as `{ssh: {...}}`
// and only to a worker that said it takes one (P8: the `x-agentx-credential-kinds` header, and the `repository.credentialKinds.v1` ping feature the dispatcher checks);
// the grant service drops any other kind. A kind no worker takes (helper) is refused here rather than sent.
import { agentXError, workerGitCredentialUsable, type GitCredential, type GitCredentialRefusal } from "@agentx/contracts";
import type { GitHubTokenScope } from "../../github-app.js";
import { WORKER_CANNOT_TAKE_CREDENTIAL, type RepositoryAccess, type RepositoryCredential } from "../../repository-access.js";
import type { CodeHostRouter } from "../../plugins/registry.js";

export const CREDENTIAL_REFUSED_MESSAGES: Readonly<Record<GitCredentialRefusal | "unsupported_kind", string>> = {
  invalid: "The code host gave a repository credential Rovara cannot use.",
  expired: "The code host gave a repository credential that has already expired.",
  too_long_lived: "The code host gave a repository credential that lasts longer than Rovara allows.",
  ssh_key_needs_service_identity: "A repository key is not handed to a task that acts for a person.",
  unsupported_kind: WORKER_CANNOT_TAKE_CREDENTIAL,
};

/** What the worker is sent for a credential that passed. A helper has no wire shape yet. */
export function workerWireCredential(credential: GitCredential): RepositoryCredential | undefined {
  if (credential.kind === "basic") return { username: credential.username, password: credential.password };
  if (credential.kind === "token") return { token: credential.token, ...(credential.username === undefined ? {} : { username: credential.username }) };
  if (credential.kind === "ssh-key") return { ssh: { privateKey: credential.privateKey, url: credential.sshUrl, knownHosts: credential.knownHosts } };
  return undefined;
}

/**
 * The resolver the repository grant service calls once a grant has matched the request. A repository registered under another credential reference gets nothing
 * (as the GitHub App provider answers), and the host is the one the repository's record names (carried in the grant).
 */
export function portCredentialResolver(input: { codeHost: CodeHostRouter; credentialRef: string; now?: () => number }): (reference: string, repositoryUrl: string, access: RepositoryAccess, scope: GitHubTokenScope, hostKind: string | undefined) => Promise<RepositoryCredential> {
  const now = input.now ?? Date.now;
  return async (reference, repositoryUrl, access, scope, hostKind) => {
    if (reference !== input.credentialRef) return {};
    const repository = { url: repositoryUrl };
    // The host is the one the repository's RECORD names (the grant carries it, signed): `forRecord`, never the address (`forRepository` answers GitHub for every address). A kind this install has not
    // registered is refused with the router's fixed sentence, and a record naming another host never gets a GitHub token.
    const host = input.codeHost.forRecord(hostKind === undefined || hostKind === "github" ? {} : { host: { kind: hostKind } });
    const credential = await host.issueGitCredential(repository, access, scope);
    // The exchange serves a task's own clone and push: the broker is the service identity here, never a person's delegated credential.
    const usable = workerGitCredentialUsable(credential, { now: now(), actingAs: "service" });
    if (!usable.ok) throw agentXError("RUNTIME_UNAVAILABLE", CREDENTIAL_REFUSED_MESSAGES[usable.reason]);
    const wire = workerWireCredential(usable.credential);
    if (wire === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CREDENTIAL_REFUSED_MESSAGES.unsupported_kind);
    return wire;
  };
}
