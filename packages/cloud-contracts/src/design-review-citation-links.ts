// Design review stage (DR11 UI): the browser-safe half of the citation rules. The task page shows a reviewer's code citation as a path, or as "not checked" when it matched nothing the reviewer was given, and builds
// a link only from `codeCitationLinkPath`. These functions moved here, unchanged, from design-review-citations.ts (which re-exports them) so the web entry takes no Node-only code. Pure.

/** The path rules of the code host's reader: relative, no empty, dot or dot-dot segment, no backslash, no hidden characters. */
export function plainPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || /[\p{Cc}\p{Cf}"<>]/u.test(path)) return false;
  if (hasDotSegment(path)) return false;
  // A percent-encoded dot segment (`%2e%2e`, also encoded twice) is a dot segment to whoever decodes it later: refused too.
  let decoded = path;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/iu.test(decoded); round += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { return false; }
    if (decoded.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(decoded) || hasDotSegment(decoded)) return false;
  }
  return true;
}
const hasDotSegment = (path: string): boolean => path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

