// N9 (INTG2): the broker's half of a registry credential. A token is minted per request, for one registry of one project, and held to three rules before the worker sees it:
//   - it must parse (printable, long enough to be scrubbed for), not be expired, and not outlive REGISTRY_TOKEN_SECONDS (plus a minute of clock skew): a minter that answers with a
//     longer-lived token is refused: the duration is the normal bound on a leak (a token is cut off early only by denying the minting role in IAM, see day-two.md);
//   - CodeArtifact's is asked for with that duration and nothing else (no 12-hour default);
//   - a failure is one fixed sentence that names the registry. What the service said (an AWS error, a path, a credential reference's value) is never carried.
// A generic registry (npm, pypi, maven the customer runs) is reached with a credential the install holds under `credentialRef`; the install supplies `stored`. Without it the
// registry is refused (fail closed), never tried without a credential.
import { REGISTRY_TOKEN_SECONDS, RegistryCredentialSchema, agentXError, type ProjectRegistry, type RegistryCredential } from "@agentx/contracts";

export interface CodeArtifactTokenRequest { domain: string; domainOwner: string; region: string; durationSeconds: number }
export interface MintedToken { token: string; expiresAt: Date; username?: string }

/** What the install can mint with. `codeArtifact` is the broker's own AWS identity; `stored` resolves a customer's credential reference (the install's Secrets Manager). */
export interface RegistryTokenSource {
  codeArtifact?(request: CodeArtifactTokenRequest): Promise<MintedToken>;
  stored?(credentialRef: string): Promise<{ token: string; username?: string }>;
}

export const REGISTRY_UNAVAILABLE_MESSAGE = (registry: string): string => `Rovara could not get a token for the package registry "${registry}". Check the registry's settings and the install's access, then try again.`;
const CLOCK_SKEW_MS = 60_000;
/** CodeArtifact's token is used with the user name `aws` (python-configure-pip.html, maven-mvn.html). */
export const CODEARTIFACT_USERNAME = "aws";

export async function mintRegistryCredential(entry: ProjectRegistry, source: RegistryTokenSource, now: () => Date = () => new Date()): Promise<RegistryCredential> {
  const refuse = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", REGISTRY_UNAVAILABLE_MESSAGE(entry.name)); };
  let minted: MintedToken;
  try {
    if (entry.kind === "codeartifact") {
      if (source.codeArtifact === undefined) return refuse();
      minted = { username: CODEARTIFACT_USERNAME, ...(await source.codeArtifact({ domain: entry.domain, domainOwner: entry.domainOwner, region: entry.region, durationSeconds: REGISTRY_TOKEN_SECONDS })) };
    } else {
      if (source.stored === undefined) return refuse();
      const held = await source.stored(entry.credentialRef);
      // A stored credential has no expiry of its own: the lease is the wire contract, and the customer's credential must be a read-only one.
      minted = { ...held, expiresAt: new Date(now().getTime() + REGISTRY_TOKEN_SECONDS * 1_000) };
    }
  } catch {
    return refuse();
  }
  const parsed = RegistryCredentialSchema.safeParse({ ...(minted.username === undefined ? {} : { username: minted.username }), token: minted.token, expiresAt: minted.expiresAt.toISOString() });
  if (!parsed.success) return refuse();
  const lifetime = minted.expiresAt.getTime() - now().getTime();
  if (lifetime <= 0 || lifetime > REGISTRY_TOKEN_SECONDS * 1_000 + CLOCK_SKEW_MS) return refuse();
  return parsed.data;
}
