// Connected sign-ins (DEC 254w): the second ways a person can sign in to their own account, read and changed through Cloud's `/v1/app/me/sign-ins` routes
// (Cloud passes them to Rovara Code as the person; Code answers 501 here until it serves them, and the page says "not connected yet").
//   GET    /v1/app/me/sign-ins                  -> { signIns: [{ method, primary, linkedAt? }], linkable?: string[] }
//   POST   /v1/app/me/sign-ins/link { method }  -> { authorizeUrl } (the provider's page)
//   DELETE /v1/app/me/sign-ins/{method}         -> { removed: true } (Code then ends every sign-in of the person)
// Every reader is total over untrusted data. Words shown come from this file, never from the server or a provider.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const MY_SIGN_INS_PATH = "/v1/app/me/sign-ins";
export const SIGN_IN_LINK_PATH = MY_SIGN_INS_PATH + "/link";
export const signInMethodPath = (method: string) => MY_SIGN_INS_PATH + "/" + encodeURIComponent(method);

export const LINKABLE_METHODS = ["slack", "github"] as const;
export type LinkableMethod = (typeof LINKABLE_METHODS)[number];
export const isLinkableMethod = (value: unknown): value is LinkableMethod => typeof value === "string" && (LINKABLE_METHODS as readonly string[]).includes(value);

const NAMES: Record<string, string> = { slack: "Slack", github: "GitHub", oidc: "Organization sign-in", cloud: "Rovara sign-in", saml: "SAML sign-in" };
/** A method's name for the page: a fixed word, "Another sign-in" for any method this app doesn't know. */
export const methodName = (method: string): string => (Object.hasOwn(NAMES, method) ? NAMES[method]! : "Another sign-in");

export interface SignInMethod { method: string; primary: boolean; linkedAt?: string }
export interface MySignIns { signIns: SignInMethod[] }
export function readMySignIns(body: unknown): MySignIns {
  if (!isRecord(body) || !Array.isArray(body["signIns"])) throw new Error("not sign-ins");
  const signIns = body["signIns"].flatMap((raw): SignInMethod[] => {
    if (!isRecord(raw) || typeof raw["method"] !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(raw["method"]) || typeof raw["primary"] !== "boolean") return [];
    const at = raw["linkedAt"];
    return [{ method: raw["method"], primary: raw["primary"], ...(typeof at === "string" && Number.isFinite(Date.parse(at)) ? { linkedAt: at } : {}) }];
  });
  return { signIns };
}

const PROVIDER_HOSTS: Record<LinkableMethod, string> = { slack: "slack.com", github: "github.com" };
/** The provider's page Cloud answered for a link: https and the method's own host, or nothing. */
export function readLinkStart(body: unknown, method: LinkableMethod): { authorizeUrl: string } {
  const value = isRecord(body) ? body["authorizeUrl"] : undefined;
  try {
    const url = new URL(typeof value === "string" ? value : "");
    if (url.protocol === "https:" && url.hostname === PROVIDER_HOSTS[method] && url.username === "" && url.password === "" && url.port === "" && url.hash === "") return { authorizeUrl: url.toString() };
  } catch { /* falls through */ }
  throw new Error("not a provider address");
}

/** What the landing address says (`?linked=<method>` or `?link=<word>`), as one fixed sentence; anything else is nothing. */
export function linkNotice(linked: string | null, link: string | null): { tone: "ok" | "bad"; text: string } | undefined {
  if (isLinkableMethod(linked)) return { tone: "ok", text: `${methodName(linked)} is connected. You can now sign in with it too.` };
  if (link === "cancelled") return { tone: "bad", text: "Connecting that sign-in was cancelled. Nothing changed." };
  if (link === "refused") return { tone: "bad", text: "That sign-in can't be connected to your account." };
  if (link === "failed") return { tone: "bad", text: "That sign-in couldn't be connected. Try again." };
  return undefined;
}
