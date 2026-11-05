// 0.5.7: the hosted cloud's optional custom domain (infra/lib/custom-domain.ts). The sign-in server and the broker read it the same way: with a name,
// `https://<name>/v1/auth` is the issuer (the address links, redirect URIs, cookies and CORS are built from), and the API's own address, which keeps
// answering, stays an issuer too: tokens signed under it are still accepted until they expire, and the sign-in server answers on that host as itself.
import { agentXError } from "@agentx/contracts";

/** A lower-case DNS name of at least two labels, as the stack parameter allows. */
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface DeveloperIssuers {
  /** The canonical issuer: the custom domain's when one is set, else the API's own. */
  issuer: string;
  /** The API's own issuer when a custom domain is set; undefined otherwise. */
  previousIssuer?: string;
}

/** `ownIssuer` is the API's own `https://<id>.execute-api.<region>.amazonaws.com/v1/auth`; `customDomain` is DEVELOPER_CUSTOM_DOMAIN (empty or unset: none). */
export function developerIssuers(ownIssuer: string, customDomain: string | undefined): DeveloperIssuers {
  if (customDomain === undefined || customDomain === "") return { issuer: ownIssuer };
  if (!DOMAIN.test(customDomain)) throw agentXError("CONFIG_INVALID", "DEVELOPER_CUSTOM_DOMAIN must be a DNS name such as staging.rovara.dev");
  return { issuer: `https://${customDomain}/v1/auth`, previousIssuer: ownIssuer };
}
