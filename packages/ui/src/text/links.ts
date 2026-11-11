import { TICKET_PATTERN } from "@agentx/cloud-contracts/web";
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

/** Same-tab GitHub installation handoff, never arbitrary external app navigation. */
export function isGithubInstallationUrl(value: string): boolean {
 const safe = safeExternalUrl(value);if(safe===undefined||safe!==value||/[#%]/.test(value))return false;
 const url=new URL(safe),entries=[...url.searchParams];
 return url.origin==="https://github.com"&&/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname)&&(entries.length===0||entries.length===1&&entries[0]![0]==="state"&&/^[A-Za-z0-9_-]{1,200}$/.test(entries[0]![1]));
}

/** The sign-in server's Slack-link address (same origin, request id only): the one full-URL hand-off the web app makes in the same tab besides GitHub's. */
export function isSlackLinkUrl(value: string, origin: string): boolean { return isIdentityLinkUrl(value, origin, "slack"); }
/** UX1: the same hand-off for linking a GitHub account from the web app. */
export function isGithubLinkUrl(value: string, origin: string): boolean { return isIdentityLinkUrl(value, origin, "github"); }
function isIdentityLinkUrl(value: string, origin: string, method: "slack" | "github"): boolean {
 const safe = safeExternalUrl(value);if (safe === undefined || safe !== value || /[#%]/.test(value)) return false;
 try { const url = new URL(safe), entries = [...url.searchParams];return url.origin === new URL(origin).origin && url.pathname === "/v1/auth/authorize" && entries.length === 2 && entries[0]![0] === "request" && /^[A-Za-z0-9_-]{16,80}$/.test(entries[0]![1]) && entries[1]![0] === "method" && entries[1]![1] === method; } catch { return false; }
}
/** UX1: an invite link on this app's own origin, `/join#invite=<token>`, which "Join my team" opens in this tab. */
export function joinLinkPath(value: string): string | undefined {
 const match = /^(?:https?:\/\/[^/?#]+)?\/join#invite=([A-Za-z0-9_-]{43})$/.exec(value.trim());
 return match === null ? undefined : `/join#invite=${match[1]!}`;
}
