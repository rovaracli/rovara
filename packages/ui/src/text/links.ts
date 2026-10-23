const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\\]/u;
export function safeExternalUrl(value: string): string | undefined {
 if (UNSAFE_TEXT.test(value) || value.trim() !== value) return undefined;
 try { const url = new URL(value);return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function isGithubUrl(value: string): boolean { const safe = safeExternalUrl(value);return safe !== undefined && new URL(safe).hostname === "github.com"; }
export function isConfirmUrl(value: string, origin: string): boolean {
 const safe = safeExternalUrl(value);if (!safe || /%2e|%2f|%5c/i.test(value)) return false;
 try { const url = new URL(safe);return url.origin === new URL(origin).origin && !url.search && !url.hash && /^\/v1\/app\/approve\/[A-Za-z0-9_-]+$/.test(url.pathname) && value.startsWith(url.origin + "/v1/app/approve/") && !value.includes("/../") && !value.includes("/./"); } catch { return false; }
}
export function safeAppPath(value: string): boolean { return !UNSAFE_TEXT.test(value) && !/%2e|%2f|%5c/i.test(value) && !value.includes("//") && !value.split(/[?#]/, 1)[0]!.split("/").some(part => part === "." || part === "..") && (value.startsWith("/app/") || value.startsWith("/s/")); }
