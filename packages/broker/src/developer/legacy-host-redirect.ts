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
