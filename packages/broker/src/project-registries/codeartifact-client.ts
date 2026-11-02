// N9 (INTG2): CodeArtifact's GetAuthorizationToken as one signed REST call, so the broker takes no new SDK client for a single operation:
//   POST https://codeartifact.<region>.amazonaws.com/v1/authorization-token?domain=<domain>&domain-owner=<owner>&duration=<seconds>
//   -> 200 {"authorizationToken": string, "expiration": number}      (SigV4, service name `codeartifact`)
// https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetAuthorizationToken.html
// The IAM the broker's role needs for it (and nothing wider) is in infra/lib/registry-access.ts. The response is parsed strictly; an error body is never read or carried.
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { z } from "zod";
import type { CodeArtifactTokenRequest, MintedToken } from "./mint.js";

type Credentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

const ResponseSchema = z.object({ authorizationToken: z.string().min(1), expiration: z.number().positive() }).passthrough();
const DOMAIN = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

export function createCodeArtifactTokenClient(options: { credentials: Credentials; fetchImplementation?: typeof fetch }): (request: CodeArtifactTokenRequest) => Promise<MintedToken> {
  const send = options.fetchImplementation ?? fetch;
  return async (request) => {
    // The request is built from validated parts only (the project schema checked them already; this is the second lock, on the way to a signed call).
    if (!DOMAIN.test(request.domain) || !/^\d{12}$/.test(request.domainOwner) || !REGION.test(request.region) || !Number.isInteger(request.durationSeconds) || request.durationSeconds < 900 || request.durationSeconds > 43_200) {
      throw new Error("invalid CodeArtifact token request");
    }
    const hostname = `codeartifact.${request.region}.amazonaws.com${request.region.startsWith("cn-") ? ".cn" : ""}`;
    const query = { domain: request.domain, "domain-owner": request.domainOwner, duration: String(request.durationSeconds) };
    const signer = new SignatureV4({ service: "codeartifact", region: request.region, credentials: options.credentials, sha256: Sha256 });
    const signed = await signer.sign({ method: "POST", protocol: "https:", hostname, path: "/v1/authorization-token", query, headers: { host: hostname } });
    const headers = { ...signed.headers };
    delete headers.host;
    const response = await send(`https://${hostname}/v1/authorization-token?${new URLSearchParams(query).toString()}`, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`CodeArtifact answered ${String(response.status)}`);
    const body = ResponseSchema.safeParse(await response.json());
    if (!body.success) throw new Error("CodeArtifact answered with an unreadable token");
    // `expiration` is a timestamp; the SDK's JSON protocol writes it as epoch seconds (a fraction is allowed).
    return { token: body.data.authorizationToken, expiresAt: new Date(body.data.expiration * 1_000) };
  };
}
