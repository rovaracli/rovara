// Plan 4 Tasks 13 to 17: fake vendor APIs for the native connectors, one handler per vendor for `routeFetch` (tests/support/developer-fakes.ts). A handler
// answers only its own vendor's hosts (anything else is left to the next handler, and an unmatched request throws), checks the credential the way the vendor
// does, and records what it was asked so a test can say which host and path a connector reached. Tasks 14 to 17 add their vendors here.

export type VendorHandler = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;

export interface RecordedRequest { method: string; url: string; authorization: string | undefined }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get("authorization") ?? undefined;
}

export interface FakeSentryIssue {
  id: string;
  shortId: string;
  title: string;
  /** The slug of the project the issue is in. */
  project: string;
  level?: string;
  status?: string;
  count?: string;
}

export interface FakeSentryOptions {
  /** The only token the fake accepts; any other is a 401. */
  token: string;
  org?: string;
  regions?: readonly ("us" | "de")[];
  issues?: readonly FakeSentryIssue[];
  /** Answers every request with this status (a vendor outage, a 429). */
  status?: number;
}

/** Sentry's API as the Sentry connector uses it: `https://<us|de>.sentry.io/api/0/...` with `Authorization: Bearer <token>`. */
export function fakeSentry(options: FakeSentryOptions): { handler: VendorHandler; requests: RecordedRequest[] } {
  const org = options.org ?? "acme";
  const regions = options.regions ?? ["us", "de"];
  const hosts = new Set(regions.map((region) => `${region}.sentry.io`));
  const issues = options.issues ?? [
    { id: "101", shortId: "WEB-1", title: "TypeError: x is undefined", project: "web-app", level: "error", status: "unresolved", count: "42" },
    { id: "102", shortId: "WEB-2", title: "Timeout in checkout", project: "web-app", level: "warning", status: "unresolved", count: "7" },
    { id: "201", shortId: "API-1", title: "Database connection lost", project: "api-app", level: "fatal", status: "unresolved", count: "3" },
  ];
  const requests: RecordedRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization: authorizationOf(init) });
    if (options.status !== undefined) return json({ detail: "fake outage" }, options.status);
    if (authorizationOf(init) !== `Bearer ${options.token}`) return json({ detail: "Invalid token" }, 401);
    const path = url.pathname;
    const issueOf = (id: string) => issues.find((issue) => issue.id === id);
    const view = (issue: FakeSentryIssue) => ({
      id: issue.id, shortId: issue.shortId, title: issue.title, level: issue.level ?? "error", status: issue.status ?? "unresolved", count: issue.count ?? "1", userCount: 2,
      firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-22T00:00:00Z", culprit: "app/checkout", permalink: `https://sentry.io/organizations/${org}/issues/${issue.id}/`,
      project: { id: "1", slug: issue.project, name: issue.project }, metadata: { type: "TypeError", value: issue.title },
    });
    if (path === `/api/0/organizations/${org}/`) return json({ slug: org, name: "Acme" });
    const projectIssues = new RegExp(`^/api/0/projects/${org}/([^/]+)/issues/$`).exec(path);
    if (projectIssues !== null) {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return json(issues.filter((issue) => issue.project === projectIssues[1]).slice(0, limit).map(view));
    }
    const latest = new RegExp(`^/api/0/organizations/${org}/issues/(\\d+)/events/latest/$`).exec(path);
    if (latest !== null) {
      const issue = issueOf(latest[1]!);
      if (issue === undefined) return json({ detail: "not found" }, 404);
      return json({
        eventID: `evt${issue.id}`, dateCreated: "2026-10-22T00:00:00Z", title: issue.title, message: issue.title, platform: "javascript",
        tags: [{ key: "environment", value: "prod" }, { key: "release", value: "web@1.2.3" }],
        user: { email: "private@example.com", ip_address: "203.0.113.9" },
        entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [{ filename: "app/checkout.js", function: "pay", lineNo: 42, inApp: true }] } }] } }],
      });
    }
    const one = new RegExp(`^/api/0/organizations/${org}/issues/(\\d+)/$`).exec(path);
    if (one !== null) {
      const issue = issueOf(one[1]!);
      return issue === undefined ? json({ detail: "not found" }, 404) : json(view(issue));
    }
    const releases = new RegExp(`^/api/0/projects/${org}/([^/]+)/releases/$`).exec(path);
    if (releases !== null) {
      return json([
        { version: "web@1.2.3", dateCreated: "2026-10-20T00:00:00Z", newGroups: 2, commitCount: 5, lastDeploy: { environment: "prod", dateFinished: "2026-10-20T01:00:00Z" } },
        { version: "web@1.2.2", dateCreated: "2026-10-10T00:00:00Z", newGroups: 0, commitCount: 1, lastDeploy: null },
      ]);
    }
    return json({ detail: "not found" }, 404);
  };
  return { handler, requests };
}
