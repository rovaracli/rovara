// Multi-tenancy: the link an invite is shared as. The origin is the hosted Rovara web app's
// (ROVARA_WEB_ORIGIN, default https://rovara.dev), where the person signs in with the invite attached.
import { createHash } from "node:crypto";
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

/**
 * The link an invite is shared as. `base` is where the join page lives (the hosted web app's `/join`, or a private install's own
 * `<issuer>/join`). A cloud link carries the token in the fragment, so a static host never receives it; a private install's link
 * keeps it in the query, because the cell reads it server-side.
 */
export const inviteUrl = (base: string, token: string, form: "fragment" | "query"): string => `${base}${form === "fragment" ? "#" : "?"}invite=${token}`;

/**
 * UX1: where a cloud invite link points: the app's own origin (the custom domain when one is set; the sign-in server's issuer is on it), which serves
 * `/join` itself (packages/web/src/server/handler.ts) and keeps the whole join on one origin, so the join's sign-in cookie is the app's.
 * Links sent earlier to the rovara.dev forwarder keep working through it.
 */
export const cloudJoinBase = (issuer: string): string => `${new URL(issuer).origin}/join`;

/** What a stored invite hash looks like: SHA-256 in base64url without padding. */
export const INVITE_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The SHA-256 of an invite token in base64url: the only form of the token a sign-in request keeps or compares. */
export const inviteTokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");
