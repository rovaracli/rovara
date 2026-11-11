import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { LEGACY_WORKER_CREDENTIAL_KINDS, agentXError, credentialKindIsSendable, credentialKindNeedsWorkerFeature, type HostScope } from "@rovara-code/contracts";

interface RepositoryGrantClaims {
  version: 3;
  ownerKey: string;
  projectName: string;
  workspaceId: string;
  operationId: string;
  repositories: RepositoryGrantScope[];
  expiresAt: number;
  nonce: string;
}

export interface RepositoryGrantScope {
  credentialRef: string;
  repositoryUrl: string;
  access: RepositoryAccess;
  /**
   * The code host the repository's RECORD names (`repositoryHostOf(record).kind`), set by the broker when it issues the grant. The credential is asked of that host and no other. A grant a
   * release before this one issued has none: the repository then had no host record, which is GitHub.
   */
  hostKind?: string;
  /**
   * The credential kinds the repository's host can hand out, set by the broker when it issues the grant, and only when one needs a worker feature (an ssh key): a grant for GitHub is
   * byte for byte what it was. The dispatcher reads it, without verifying it, to refuse a worker that lacks the feature before any compute is spent; the exchange never relies on it.
   */
  credentialKinds?: string[];
}

export type RepositoryAccess = "clone" | "push";

export interface RepositoryCredential {
  username?: string;
  password?: string;
  token?: string;
  /** An ssh key credential (P8): the key, the `ssh://` address to use in place of the repository's https address, and the pinned host keys. Only a worker that said it takes `ssh-key` is sent one. */
  ssh?: { privateKey: string; url: string; knownHosts: string };
}

/** Said when a host's credential is of a kind the asking worker did not say it takes. Fixed; carries nothing of the credential. */
export const WORKER_CANNOT_TAKE_CREDENTIAL = "The code host gave a kind of repository credential this worker cannot take yet.";

/** The kind a resolved credential is of, or undefined for none (a repository under another credential reference gets `{}`). */
export function credentialKindOf(credential: RepositoryCredential): "ssh-key" | "basic" | "token" | undefined {
  if (credential.ssh !== undefined) return "ssh-key";
  if (credential.password !== undefined) return "basic";
  if (credential.token !== undefined) return "token";
  return undefined;
}

/**
 * The credential kinds a grant's repositories can need beyond the legacy two, read from the grant WITHOUT verifying its signature (the dispatcher holds no key). A forged grant can only
 * change whether the dispatcher refuses early; the exchange verifies the grant and checks the credential itself. A value that cannot be read names nothing.
 */
export function nonLegacyCredentialKindsOfGrant(grant: string): string[] {
  try {
    const [payload] = grant.split(".");
    if (payload === undefined || payload === "") return [];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { repositories?: unknown };
    if (!Array.isArray(claims.repositories)) return [];
    const kinds = new Set<string>();
    for (const repository of claims.repositories) {
      const named = (repository as { credentialKinds?: unknown } | null)?.credentialKinds;
      if (!Array.isArray(named)) continue;
      for (const kind of named) if (typeof kind === "string" && credentialKindIsSendable(kind) && credentialKindNeedsWorkerFeature(kind)) kinds.add(kind);
    }
    return [...kinds].sort();
  } catch {
    return [];
  }
}

export class RepositoryGrantService {
  constructor(
    private readonly signingKey: Buffer,
    private readonly resolveCredential: (
      reference: string,
      repositoryUrl: string,
      access: RepositoryAccess,
      scope: HostScope,
      hostKind: string | undefined,
    ) => Promise<RepositoryCredential>,
    /** The credential kinds a code host can hand out (its capabilities), by the kind the repository's record names. Absent: no grant names kinds. */
    private readonly credentialKindsOf?: (hostKind: string) => readonly string[] | undefined,
  ) {
    if (signingKey.byteLength < 32) throw new Error("repository grant signing key must be at least 32 bytes");
  }

  issue(input: {
    ownerKey: string;
    projectName: string;
    workspaceId: string;
    operationId: string;
    repositories: readonly RepositoryGrantScope[];
    ttlSeconds?: number;
  }): string {
    const claims: RepositoryGrantClaims = {
      version: 3,
      ownerKey: input.ownerKey,
      projectName: input.projectName,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      repositories: uniqueScopes(input.repositories).map((scope) => this.withCredentialKinds(scope)),
      expiresAt: Math.floor(Date.now() / 1_000) + (input.ttlSeconds ?? 900),
      nonce: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  async exchange(
    grant: string,
    request: {
      workspaceId: string;
      operationId: string;
      credentialRef: string;
      repositoryUrl: string;
      access: RepositoryAccess;
      /** The kinds the asking worker said it takes. Absent: the legacy two (`token`, `basic`), so a caller that says nothing is never sent an ssh key. */
      acceptedCredentialKinds?: readonly string[];
    },
    /** Whose work the token is for (Plan 2, Task 15): the workspace's org, so an org that disconnected GitHub mints nothing. */
    scope: HostScope,
  ): Promise<RepositoryCredential> {
    const claims = this.verify(grant);
    const covering = claims.repositories.filter(
      (repository) =>
        repository.credentialRef === request.credentialRef &&
        repository.repositoryUrl === request.repositoryUrl &&
        repository.access === request.access,
    );
    if (claims.workspaceId !== request.workspaceId || claims.operationId !== request.operationId || covering.length === 0) {
      throw agentXError("FORBIDDEN", "repository credential grant does not cover this request");
    }
    // One address held by repositories on different hosts is not told apart by the address: refused, never guessed.
    if (new Set(covering.map((repository) => repository.hostKind ?? "github")).size > 1) {
      throw agentXError("FORBIDDEN", "repository credential grant does not cover this request");
    }
    const credential = await this.resolveCredential(request.credentialRef, request.repositoryUrl, request.access, scope, covering[0]!.hostKind);
    // P8, fail closed: a kind the asker did not say it takes is dropped here, never sent (an older worker would refuse the shape, or worse, misread it).
    const kind = credentialKindOf(credential);
    if (kind !== undefined && !(request.acceptedCredentialKinds ?? LEGACY_WORKER_CREDENTIAL_KINDS).includes(kind)) {
      throw agentXError("RUNTIME_UNAVAILABLE", WORKER_CANNOT_TAKE_CREDENTIAL);
    }
    return credential;
  }

  private withCredentialKinds(scope: RepositoryGrantScope): RepositoryGrantScope {
    if (this.credentialKindsOf === undefined || scope.hostKind === undefined) return scope;
    let kinds: readonly string[] | undefined;
    try {
      kinds = this.credentialKindsOf(scope.hostKind);
    } catch {
      return scope;
    }
    // Only kinds the exchange can send count: a `helper` has no wire shape and is never sent, so a host that lists one is not made undispatchable by it.
    const sendable = [...new Set(kinds ?? [])].filter(credentialKindIsSendable);
    return sendable.some(credentialKindNeedsWorkerFeature) ? { ...scope, credentialKinds: sendable.sort() } : scope;
  }

  inspect(grant: string): Omit<RepositoryGrantClaims, "nonce"> {
    const claims = this.verify(grant);
    return {
      version: claims.version,
      ownerKey: claims.ownerKey,
      projectName: claims.projectName,
      workspaceId: claims.workspaceId,
      operationId: claims.operationId,
      repositories: claims.repositories,
      expiresAt: claims.expiresAt,
    };
  }

  private verify(grant: string): RepositoryGrantClaims {
    const [payload, signature, extra] = grant.split(".");
    if (!payload || !signature || extra) throw agentXError("FORBIDDEN", "invalid repository grant");
    const expected = Buffer.from(this.sign(payload), "base64url");
    const received = Buffer.from(signature, "base64url");
    if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
      throw agentXError("FORBIDDEN", "invalid repository grant signature");
    }
    let claims: RepositoryGrantClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RepositoryGrantClaims;
    } catch {
      throw agentXError("FORBIDDEN", "invalid repository grant payload");
    }
    if (
      claims.version !== 3 ||
      !Array.isArray(claims.repositories) ||
      claims.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw agentXError("FORBIDDEN", "repository grant is expired or unsupported");
    }
    return claims;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }
}

function uniqueScopes(scopes: readonly RepositoryGrantScope[]): RepositoryGrantScope[] {
  const seen = new Set<string>();
  return scopes.flatMap((scope) => {
    const key = `${scope.credentialRef}\0${scope.repositoryUrl}\0${scope.access}\0${scope.hostKind ?? "github"}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...scope }];
  });
}
