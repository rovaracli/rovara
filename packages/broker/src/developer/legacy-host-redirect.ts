// 0.5.7: with a custom domain, browser pages (the task review page, the audit view) belong on it: their cookies are host-only
// (`__Host-`), and the sign-in that sets them runs as the canonical issuer. A GET that arrives on the API's own address (an old
// Slack link, a bookmark) is sent on to the same path on the custom domain with a temporary redirect, so a rollback leaves no
// cached redirect behind. Nothing else is redirected: the machine routes and the CLI keep answering on the API's own address.
export interface LegacyHostRedirectInput {
  /** The configuration's canonical issuer and the API's own (`previousIssuer`): absent means no custom domain, and nothing is redirected. */
  issuer: string;
  previousIssuer?: string | undefined;
  method: string;
  headers: Record<string, string | undefined>;
  /** The request's path with its query. */
  path: string;
}

export function legacyHostRedirect(input: LegacyHostRedirectInput): { statusCode: 307; headers: Record<string, string>; body: string } | undefined {
  if (input.previousIssuer === undefined || input.method !== "GET") return undefined;
  const host = Object.entries(input.headers).find(([name]) => name.toLowerCase() === "host")?.[1]?.toLowerCase();
  if (host === undefined || host !== new URL(input.previousIssuer).host.toLowerCase()) return undefined;
  if (!input.path.startsWith("/") || input.path.startsWith("//")) return undefined;
  return { statusCode: 307, headers: { location: `${new URL(input.issuer).origin}${input.path}`, "cache-control": "no-store" }, body: "" };
}

/**
 * The origin machine addresses are built on: the API's own when a custom domain is set (`previousIssuer`), else the issuer's. Vendors' event-hook URLs
 * (`/v1/hooks/...`) are registered at other companies once and must keep resolving when the domain is removed or rolled back, so they never move.
 */
export const machineOrigin = (developer: { issuer: string; previousIssuer?: string | undefined }): string => new URL(developer.previousIssuer ?? developer.issuer).origin;

/** The browser pages a person can reach from an old link on the API's own address: each GET moves to the domain, where its cookies, sign-in and Origin checks live. */
export const BROWSER_PAGE_PREFIXES = ["/review/", "/v1/app/approve/", "/v1/app/audit/view"] as const;
export const GITHUB_INSTALL_CALLBACK = "/v1/github/install/callback";
export const isBrowserPagePath = (pathname: string): boolean => pathname === GITHUB_INSTALL_CALLBACK || BROWSER_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
