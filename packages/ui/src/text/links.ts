import { TICKET_PATTERN } from "@agentx/contracts/web";
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\\]/u;
export function safeExternalUrl(value: string): string | undefined {
 if (UNSAFE_TEXT.test(value) || value.trim() !== value) return undefined;
 try { const url = new URL(value);return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function isGithubUrl(value: string): boolean { const safe = safeExternalUrl(value);return safe !== undefined && new URL(safe).hostname === "github.com"; }
export function isConfirmUrl(value: string, origin: string): boolean {
 const safe = safeExternalUrl(value);if (!safe || /%2e|%2f|%5c/i.test(value) || value.includes("#")) return false;
 try {
  const url = new URL(safe);
  if (url.origin !== new URL(origin).origin || !/^\/v1\/app\/approve\/[A-Za-z0-9_-]+$/.test(url.pathname) || !value.startsWith(url.origin + "/v1/app/approve/") || value.includes("/../") || value.includes("/./")) return false;
  if (!value.includes("?")) return true;
  const entries = [...url.searchParams];
  return entries.length === 1 && entries[0]![0] === "ticket" && TICKET_PATTERN.test(entries[0]![1]) && url.search === "?ticket=" + entries[0]![1];
 } catch { return false; }
}
export function safeAppPath(value: string): boolean { return !UNSAFE_TEXT.test(value) && !/%2e|%2f|%5c/i.test(value) && !value.includes("//") && !value.split(/[?#]/, 1)[0]!.split("/").some(part => part === "." || part === "..") && (value.startsWith("/app/") || value.startsWith("/s/")); }

/** GitHub's own authorization page for the App (the "already installed" path), with only its client id and Rovara's state. */
export function isGithubAuthorizeUrl(value: string): boolean {
 const safe = safeExternalUrl(value);if(safe===undefined||safe!==value||/[#%]/.test(value))return false;
 const url=new URL(safe),entries=[...url.searchParams];
 return url.origin==="https://github.com"&&url.pathname==="/login/oauth/authorize"&&entries.length===2&&entries[0]![0]==="client_id"&&/^[A-Za-z0-9.]{1,64}$/.test(entries[0]![1])&&entries[1]![0]==="state"&&/^[A-Za-z0-9_-]{1,200}$/.test(entries[1]![1]);
}
/** Same-tab GitHub installation handoff, never arbitrary external app navigation. */
export function isGithubInstallationUrl(value: string): boolean {
 const safe = safeExternalUrl(value);if(safe===undefined||safe!==value||/[#%]/.test(value))return false;
 const url=new URL(safe),entries=[...url.searchParams];
 return url.origin==="https://github.com"&&/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname)&&(entries.length===0||entries.length===1&&entries[0]![0]==="state"&&/^[A-Za-z0-9_-]{1,200}$/.test(entries[0]![1]));
}
/** Same-tab hand-off to a provider's consent page that comes back to this app's own callback (guided onboarding PR 11), with exactly the given query keys. */
function isConsentUrl(value: string, appOrigin: string, origin: string, path: string, keys: readonly string[], callbackPath: string): boolean {
 const safe = safeExternalUrl(value);if(safe===undefined||safe!==value||value.includes("#"))return false;
 try {
  const url=new URL(safe),q=url.searchParams,found=[...q.keys()].sort();
  return url.origin===origin&&url.pathname===path&&found.length===keys.length&&found.every((key,index)=>key===keys[index])&&/^[A-Za-z0-9_-]{43}$/.test(q.get("state")??"")&&q.get("redirect_uri")===new URL(appOrigin).origin+callbackPath;
 } catch { return false; }
}
/** Slack's OAuth v2 page for Add to Slack, coming back to this app's /api/connect/slack/callback. */
export function isSlackAuthorizeUrl(value: string, appOrigin: string): boolean { return isConsentUrl(value, appOrigin, "https://slack.com", "/oauth/v2/authorize", ["client_id", "redirect_uri", "scope", "state"], "/api/connect/slack/callback"); }
/** Linear's consent page for Connect Linear (as the app, PKCE), coming back to this app's /api/connect/linear/callback. */
export function isLinearAuthorizeUrl(value: string, appOrigin: string): boolean {
 return isConsentUrl(value, appOrigin, "https://linear.app", "/oauth/authorize", ["actor", "client_id", "code_challenge", "code_challenge_method", "prompt", "redirect_uri", "response_type", "scope", "state"], "/api/connect/linear/callback")&&new URL(value).searchParams.get("actor")==="app";
}
