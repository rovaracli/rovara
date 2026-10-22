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
  /** The project issues endpoint answers with every project's issues, as a misbehaving vendor (or a free-form query) could make it. */
  leakOtherProjects?: boolean;
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
      return json(issues.filter((issue) => options.leakOtherProjects === true || issue.project === projectIssues[1]).slice(0, limit).map(view));
    }
    const latest = new RegExp(`^/api/0/organizations/${org}/issues/(\\d+)/events/latest/$`).exec(path);
    if (latest !== null) {
      const issue = issueOf(latest[1]!);
      if (issue === undefined) return json({ detail: "not found" }, 404);
      return json({
        eventID: `evt${issue.id}`, dateCreated: "2026-10-22T00:00:00Z", title: issue.title, message: issue.title, platform: "javascript",
        tags: [
          { key: "environment", value: "prod" }, { key: "release", value: "web@1.2.3" }, { key: "browser.name", value: "Chrome" },
          // What real events carry about the person and the request: none of it may reach the model.
          { key: "user", value: "id:4242" }, { key: "user.email", value: "private@example.com" }, { key: "url", value: "https://shop.example/cart?token=abc" },
          { key: "ip", value: "203.0.113.9" }, { key: "client_ip", value: "203.0.113.10" }, { key: "server_name", value: "web-7f9c" }, { key: "customer_id", value: "cus_123456" },
        ],
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

// ---- Datadog (Task 14)

export interface FakeDatadogMonitor { id: number; name: string; type?: string; overall_state?: string; tags: string[]; query?: string }

export interface FakeDatadogOptions {
  apiKey: string;
  appKey: string;
  /** The API hosts it answers for; default api.datadoghq.eu. */
  hosts?: readonly string[];
  monitors?: readonly FakeDatadogMonitor[];
  /** A message the first log carries (to prove a key echoed back is scrubbed). */
  logMessage?: string;
  /** Answers every request with this status (an outage, a 429). */
  status?: number;
}

export interface RecordedDatadogRequest { method: string; url: string; apiKey: string | undefined; appKey: string | undefined; body: unknown }

/** Datadog's API as the connector uses it: `https://api.<site>/api/...` with `DD-API-KEY` and `DD-APPLICATION-KEY`. */
export function fakeDatadog(options: FakeDatadogOptions): { handler: VendorHandler; requests: RecordedDatadogRequest[] } {
  const hosts = new Set(options.hosts ?? ["api.datadoghq.eu"]);
  const monitors = options.monitors ?? [
    { id: 11, name: "Payments latency", type: "metric alert", overall_state: "Alert", tags: ["service:payments", "env:prod", "team:core"], query: "avg(last_5m):avg:payments.latency{env:prod} > 2" },
    { id: 12, name: "Billing errors", type: "log alert", overall_state: "OK", tags: ["service:billing", "env:prod"], query: "logs(\"service:billing status:error\").index(\"*\").rollup(\"count\").last(\"5m\") > 10" },
  ];
  const requests: RecordedDatadogRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, apiKey: headers.get("dd-api-key") ?? undefined, appKey: headers.get("dd-application-key") ?? undefined, body });
    if (options.status !== undefined) return json({ errors: ["fake outage with details"] }, options.status);
    const apiOk = headers.get("dd-api-key") === options.apiKey;
    const appOk = headers.get("dd-application-key") === options.appKey;
    if (url.pathname === "/api/v1/validate") return apiOk ? json({ valid: true }) : json({ errors: ["Forbidden"] }, 403);
    if (!apiOk || !appOk) return json({ errors: ["Forbidden"] }, 403);
    if (url.pathname === "/api/v1/monitor/search") {
      return json({ monitors: monitors.map((monitor) => ({ id: monitor.id, name: monitor.name, status: monitor.overall_state, type: monitor.type, tags: monitor.tags })), metadata: { page: 0, page_count: 1, per_page: 25, total_count: monitors.length } });
    }
    const one = /^\/api\/v1\/monitor\/(\d+)$/.exec(url.pathname);
    if (one !== null) {
      const monitor = monitors.find((entry) => entry.id === Number(one[1]));
      return monitor === undefined ? json({ errors: ["Monitor not found"] }, 404) : json({ ...monitor, message: "Page the on-call @pagerduty-core" });
    }
    if (url.pathname === "/api/v1/query") {
      return json({ status: "ok", query: url.searchParams.get("query"), series: [{ metric: "payments.latency", scope: "service:payments,env:prod", pointlist: [[1_760_000_000_000, 1.5], [1_760_000_060_000, 2.5], [1_760_000_120_000, 0.5]] }] });
    }
    if (url.pathname === "/api/v2/logs/events/search" && init?.method === "POST") {
      return json({ data: [
        { id: "l1", type: "log", attributes: { timestamp: "2026-10-22T10:00:00Z", status: "error", service: "billing", message: options.logMessage ?? "charge failed for order 17", tags: ["env:prod"] } },
        { id: "l2", type: "log", attributes: { timestamp: "2026-10-22T09:59:00Z", status: "info", service: "billing", message: "charge started", tags: ["env:prod"] } },
      ] });
    }
    return json({ errors: ["not found"] }, 404);
  };
  return { handler, requests };
}

// ---- Grafana (Task 14)

export interface FakeGrafanaOptions {
  token: string;
  host?: string;
  /** A path the Grafana is served under, such as `/grafana`. */
  basePath?: string;
  /** Answers /api/health alone with this status (the rest keep working). */
  healthStatus?: number;
  /** Answers every request with this status. */
  status?: number;
  /** A body for /api/ds/query's result, to test failures. */
  queryError?: boolean;
}

export interface RecordedGrafanaRequest { method: string; url: string; authorization: string | undefined; body: unknown }

/** Grafana's HTTP API as the connector uses it: alert rules in two folders, firing alerts for them, two dashboards and a Prometheus data source. */
export function fakeGrafana(options: FakeGrafanaOptions): { handler: VendorHandler; requests: RecordedGrafanaRequest[] } {
  const host = options.host ?? "grafana.acme.dev";
  const requests: RecordedGrafanaRequest[] = [];
  const rules = [
    { uid: "rule-pay", title: "Payments error rate", folderUID: "fold-pay", ruleGroup: "payments", condition: "C", for: "5m", noDataState: "NoData", execErrState: "Error", labels: { severity: "critical" }, annotations: { summary: "Payments are failing" }, data: [{ refId: "A", datasourceUid: "prom1", model: { expr: "rate(payments_errors_total[5m])" } }] },
    { uid: "rule-web", title: "Web latency", folderUID: "fold-web", ruleGroup: "web", condition: "C", for: "10m", labels: { severity: "warning" }, annotations: { summary: "Web is slow" }, data: [] },
  ];
  const dashboards: Record<string, unknown> = {
    "dash-pay": { dashboard: { uid: "dash-pay", title: "Payments overview", tags: ["payments"], panels: [{ id: 1, title: "Error rate", type: "timeseries", targets: [{ expr: "rate(payments_errors_total[5m])" }] }] }, meta: { folderUid: "fold-pay", folderTitle: "Payments", version: 3 } },
    "dash-web": { dashboard: { uid: "dash-web", title: "Web overview", tags: [], panels: [] }, meta: { folderUid: "fold-web", folderTitle: "Web", version: 1 } },
  };
  const handler: VendorHandler = async (url, init) => {
    if (url.hostname !== host) return undefined;
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization, body });
    if (options.status !== undefined) return json({ message: "fake outage with details" }, options.status);
    const path = options.basePath !== undefined && url.pathname.startsWith(`${options.basePath}/`) ? url.pathname.slice(options.basePath.length) : url.pathname;
    if (path === "/api/health" && options.healthStatus !== undefined) return json({ message: "unhealthy" }, options.healthStatus);
    if (path === "/api/health") return json({ commit: "abc", database: "ok", version: "11.0.0" });
    if (authorization !== `Bearer ${options.token}`) return json({ message: "Unauthorized" }, 401);
    if (path === "/api/user") return json({ id: 5, login: "sa-rovara", isServiceAccount: true });
    if (path === "/api/v1/provisioning/alert-rules") return json(rules);
    const rule = /^\/api\/v1\/provisioning\/alert-rules\/([^/]+)$/.exec(path);
    if (rule !== null) {
      const found = rules.find((entry) => entry.uid === rule[1]);
      return found === undefined ? json({ message: "not found" }, 404) : json(found);
    }
    if (path === "/api/alertmanager/grafana/api/v2/alerts") {
      return json([
        { labels: { alertname: "Payments error rate", __alert_rule_uid__: "rule-pay", grafana_folder: "Payments", severity: "critical" }, annotations: { summary: "Payments are failing" }, status: { state: "active" }, startsAt: "2026-10-22T09:00:00Z" },
        { labels: { alertname: "Web latency", __alert_rule_uid__: "rule-web", grafana_folder: "Web", severity: "warning" }, annotations: { summary: "Web is slow" }, status: { state: "active" }, startsAt: "2026-10-22T09:30:00Z" },
      ]);
    }
    const dashboard = /^\/api\/dashboards\/uid\/([^/]+)$/.exec(path);
    if (dashboard !== null) return dashboards[dashboard[1]!] === undefined ? json({ message: "Dashboard not found" }, 404) : json(dashboards[dashboard[1]!]);
    if (path === "/api/ds/query" && init?.method === "POST") {
      if (options.queryError === true) return json({ results: { A: { error: "bad expression near token", status: 400 } } });
      return json({ results: { A: { status: 200, frames: [{
        schema: { fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels: { job: "payments" } }] },
        data: { values: [[1_760_000_000_000, 1_760_000_060_000, 1_760_000_120_000], [1.5, 2.5, 0.5]] },
      }] } } });
    }
    return json({ message: "not found" }, 404);
  };
  return { handler, requests };
}

// ---- PagerDuty (Task 15)

export interface FakePagerDutyOptions {
  apiKey: string;
  /** The API hosts it answers for; default api.pagerduty.com. */
  hosts?: readonly string[];
  /** Answers every request with this status. */
  status?: number;
  /** The incident list ignores the `service_ids[]` filter, as a misbehaving vendor could. */
  ignoreServiceFilter?: boolean;
  /** The on-call list ignores the `escalation_policy_ids[]` filter. */
  ignoreOncallFilter?: boolean;
}

export interface RecordedPagerDutyRequest { method: string; url: string; authorization: string | undefined; accept: string | undefined }

/** PagerDuty's REST API v2 as the connector uses it: two services (PSVC001, PSVC002), their policies, incidents on each, and on-calls. */
export function fakePagerDuty(options: FakePagerDutyOptions): { handler: VendorHandler; requests: RecordedPagerDutyRequest[] } {
  const hosts = new Set(options.hosts ?? ["api.pagerduty.com"]);
  const services: Record<string, { id: string; summary: string; escalation_policy: { id: string; summary: string } }> = {
    PSVC001: { id: "PSVC001", summary: "Payments", escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
    PSVC002: { id: "PSVC002", summary: "Billing", escalation_policy: { id: "PEP0002", summary: "Billing on-call" } },
    // Shares the Payments escalation policy.
    PSVC003: { id: "PSVC003", summary: "Payments batch", escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
  };
  const incidents = [
    { id: "PINC001", incident_number: 101, title: "Payments API 5xx", status: "triggered", urgency: "high", service: { id: "PSVC001", summary: "Payments" }, created_at: "2026-10-22T09:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC001", assignments: [{ at: "2026-10-22T09:00:05Z", assignee: { id: "PUSER01", summary: "Dana Ops" } }], escalation_policy: { id: "PEP0001", summary: "Payments on-call" } },
    { id: "PINC002", incident_number: 102, title: "Payments latency", status: "resolved", urgency: "low", service: { id: "PSVC001", summary: "Payments" }, created_at: "2026-10-21T09:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC002" },
    { id: "PINC003", incident_number: 103, title: "Billing batch failed", status: "acknowledged", urgency: "high", service: { id: "PSVC002", summary: "Billing" }, created_at: "2026-10-22T08:00:00Z", html_url: "https://acme.pagerduty.com/incidents/PINC003" },
  ];
  const requests: RecordedPagerDutyRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (!hosts.has(url.hostname)) return undefined;
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization: headers.get("authorization") ?? undefined, accept: headers.get("accept") ?? undefined });
    if (options.status !== undefined) return json({ error: { message: "fake outage with details" } }, options.status);
    if (headers.get("authorization") !== `Token token=${options.apiKey}`) return json({ error: { message: "Unauthorized", code: 2006 } }, 401);
    if (headers.get("accept") !== "application/vnd.pagerduty+json;version=2") return json({ error: { message: "bad version" } }, 400);
    if (url.pathname === "/abilities") return json({ abilities: ["teams", "urgencies"] });
    if (url.pathname === "/incidents") {
      const wanted = url.searchParams.getAll("service_ids[]");
      const statuses = url.searchParams.getAll("statuses[]");
      const found = incidents.filter((incident) => (options.ignoreServiceFilter === true || wanted.includes(incident.service.id)) && (statuses.length === 0 || statuses.includes(incident.status)));
      return json({ incidents: found, limit: 25, offset: 0, more: false });
    }
    const one = /^\/incidents\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (one !== null) {
      const found = incidents.find((incident) => incident.id === one[1]);
      return found === undefined ? json({ error: { message: "Not Found", code: 2100 } }, 404) : json({ incident: found });
    }
    const entries = /^\/incidents\/([A-Za-z0-9]+)\/log_entries$/.exec(url.pathname);
    if (entries !== null) {
      return json({ log_entries: [
        { id: "L1", type: "trigger_log_entry", summary: "Triggered through the API", created_at: "2026-10-22T09:00:00Z", agent: { id: "PAGENT1", type: "service_reference", summary: "Payments monitor" }, channel: { type: "api", details: "secret-routing-key-123" } },
        { id: "L2", type: "acknowledge_log_entry", summary: "Acknowledged by Dana Ops", created_at: "2026-10-22T09:05:00Z", agent: { id: "PUSER01", type: "user_reference", summary: "Dana Ops" } },
      ], limit: 50, offset: 0, more: false });
    }
    const service = /^\/services\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (service !== null) return services[service[1]!] === undefined ? json({ error: { message: "Not Found" } }, 404) : json({ service: services[service[1]!] });
    if (url.pathname === "/oncalls") {
      const policies = url.searchParams.getAll("escalation_policy_ids[]");
      const all = [
        { user: { id: "PUSER01", summary: "Dana Ops" }, escalation_policy: { id: "PEP0001", summary: "Payments on-call" }, escalation_level: 1, start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", schedule: { id: "PSCH001", summary: "Payments primary" } },
        { user: { id: "PUSER02", summary: "Eli Billing" }, escalation_policy: { id: "PEP0002", summary: "Billing on-call" }, escalation_level: 1, start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", schedule: { id: "PSCH002", summary: "Billing primary" } },
      ];
      return json({ oncalls: all.filter((entry) => options.ignoreOncallFilter === true || policies.includes(entry.escalation_policy.id)), limit: 25, offset: 0, more: false });
    }
    return json({ error: { message: "Not Found" } }, 404);
  };
  return { handler, requests };
}

// ---- Vercel (Task 15)

export interface FakeVercelOptions {
  token: string;
  /** Answers every request with this status. */
  status?: number;
  /** The deployment list ignores the `projectId` filter. */
  ignoreProjectFilter?: boolean;
}

export interface RecordedVercelRequest { method: string; url: string; authorization: string | undefined }

/** Vercel's REST API as the connector uses it: deployments of two projects (prj_web1, prj_api1) with build events. */
export function fakeVercel(options: FakeVercelOptions): { handler: VendorHandler; requests: RecordedVercelRequest[] } {
  const deployments = [
    { uid: "dpl_web1prod", name: "web", projectId: "prj_web1", readyState: "READY", state: "READY", target: "production", url: "web-abc.vercel.app", created: 1_760_000_000_000, creator: { uid: "u1", username: "dana", email: "dana@example.com" }, meta: { githubCommitMessage: "Fix checkout", githubCommitRef: "main", githubCommitSha: "abc123", githubCommitAuthorEmail: "dana@example.com" }, inspectorUrl: "https://vercel.com/acme/web/abc" },
    { uid: "dpl_web1prev", name: "web", projectId: "prj_web1", readyState: "ERROR", state: "ERROR", target: null, url: "web-def.vercel.app", created: 1_759_990_000_000, creator: { uid: "u1", username: "dana", email: "dana@example.com" }, meta: { githubCommitMessage: "Try a thing", githubCommitRef: "feature" }, errorMessage: "Build failed", errorCode: "BUILD_FAILED" },
    { uid: "dpl_api1prod", name: "api", projectId: "prj_api1", readyState: "READY", state: "READY", target: "production", url: "api-ghi.vercel.app", created: 1_759_980_000_000, creator: { uid: "u2", username: "eli" } },
  ];
  const requests: RecordedVercelRequest[] = [];
  const handler: VendorHandler = async (url, init) => {
    if (url.hostname !== "api.vercel.com") return undefined;
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    requests.push({ method: init?.method ?? "GET", url: url.href, authorization });
    if (options.status !== undefined) return json({ error: { code: "fake", message: "fake outage with details" } }, options.status);
    if (authorization !== `Bearer ${options.token}`) return json({ error: { code: "forbidden", message: "Not authorized" } }, 403);
    if (url.pathname === "/v2/user") return json({ user: { id: "AEIIDYVk59zbFF2Sxfyxxmua", username: "rovara" } });
    if (url.pathname === "/v7/deployments" || url.pathname === "/v6/deployments") {
      const project = url.searchParams.get("projectId");
      const target = url.searchParams.get("target");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const found = deployments.filter((entry) => (options.ignoreProjectFilter === true || entry.projectId === project) && (target === null || entry.target === target)).slice(0, limit);
      return json({ deployments: found, pagination: { count: found.length, next: null, prev: null } });
    }
    const one = /^\/v13\/deployments\/([^/]+)$/.exec(url.pathname);
    if (one !== null) {
      const found = deployments.find((entry) => entry.uid === one[1]);
      return found === undefined ? json({ error: { code: "not_found", message: "no such deployment" } }, 404) : json({ id: found.uid, ...found, createdAt: found.created });
    }
    const events = /^\/v3\/deployments\/([^/]+)\/events$/.exec(url.pathname);
    if (events !== null) {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const all = [
        { type: "command", created: 1_760_000_001_000, payload: { text: "npm run build", deploymentId: events[1], id: "e1", serial: "1", date: 1 } },
        { type: "stdout", created: 1_760_000_002_000, payload: { text: "compiled with a warning", deploymentId: events[1], id: "e2", serial: "2", date: 2 } },
        { type: "stderr", created: 1_760_000_003_000, payload: { text: "Error: boom in build", deploymentId: events[1], id: "e3", serial: "3", date: 3 } },
      ];
      // Like Vercel, `direction=backward` answers the newest first.
      return json((url.searchParams.get("direction") === "backward" ? [...all].reverse() : all).slice(0, limit));
    }
    return json({ error: { code: "not_found", message: "not found" } }, 404);
  };
  return { handler, requests };
}
