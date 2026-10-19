// Multi-tenancy: the link an invite is shared as. The origin is the hosted Rovara web app's
// (ROVARA_WEB_ORIGIN, default https://rovara.dev), where the person signs in with the invite attached.
import { agentXError } from "@agentx/contracts";

export const DEFAULT_ROVARA_WEB_ORIGIN = "https://rovara.dev";

/** What an invite token looks like in a link or query: 32 random bytes, base64url without padding. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The web origin from the environment: unset or empty is the default. Anything but an https origin (or
 * http://localhost, for development) is CONFIG_INVALID, so a typo fails at startup rather than mailing out a bad link.
 */
export function webOriginFromEnvironment(env: Record<string, string | undefined>): string {
  const raw = env.ROVARA_WEB_ORIGIN;
  if (raw === undefined || raw === "") return DEFAULT_ROVARA_WEB_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw agentXError("CONFIG_INVALID", "ROVARA_WEB_ORIGIN must be an https origin such as https://rovara.dev");
  }
  const local = url.protocol === "http:" && url.hostname === "localhost";
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  if ((url.protocol !== "https:" && !local) || !bare) {
    throw agentXError("CONFIG_INVALID", "ROVARA_WEB_ORIGIN must be an https origin such as https://rovara.dev (http://localhost is allowed for development)");
  }
  return url.origin;
}

export const inviteUrl = (webOrigin: string, token: string): string => `${webOrigin}/join?invite=${token}`;
