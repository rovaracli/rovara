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
