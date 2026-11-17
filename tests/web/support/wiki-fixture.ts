// The wiki a made-up project ("Beacon", four repos) has, in the shape Rovara Code's wiki read routes answer (Code W2 contract wiki-store.ts at 07cd73a5f; Cloud's mirror is
// packages/contracts/src/app-wiki.ts). Used by the fake Code (tests/support/fake-code.ts, which re-exports it from tests/support/wiki-fixture.ts) and by the unit and browser tests. It lives under tests/web/support so the web tests' own TypeScript project can read it. Every name, number and line here is an example.
import { WIKI_TRUST_LINE, type WikiBlock, type WikiIndexResponse, type WikiPageResponse, type WikiShownClaim, type WikiShownNote, type WikiSourcesResponse, type WikiSourceState } from "../../../packages/contracts/src/app-wiki.js";

const DAY = 86_400_000;
export const FIXTURE_NOW = Date.UTC(2026, 10, 17, 12);
const iso = (ago: number) => new Date(FIXTURE_NOW - ago * DAY).toISOString();
/** A full commit hash for a repo (deterministic, 40 hex characters). */
export const commitOf = (repo: string): string => { let h = ""; for (let i = 0; h.length < 40; i += 1) h += ((repo.charCodeAt(i % repo.length) * 31 + i * 17) % 256).toString(16).padStart(2, "0"); return h.slice(0, 40); };
export const REPOS = ["beacon-web", "beacon-api", "beacon-agents", "beacon-legacy"] as const;

type Kind = WikiIndexResponse["pages"][number]["kind"];
interface ClaimDef { id: string; text: string; repo: string; path: string; line: number; lineEnd?: number; source?: WikiSourceState; flagged?: boolean }
const claim = (id: string, text: string, repo: string, path: string, line: number, lineEnd?: number, extra: Partial<ClaimDef> = {}): ClaimDef => ({ id, text, repo, path, line, ...(lineEnd === undefined ? {} : { lineEnd }), ...extra });
const H = (id: string, text: string, level: 2 | 3 = 2): WikiBlock => ({ kind: "heading", blockId: id, level, text });
const P = (id: string, text: string, claimIds: string[] = []): WikiBlock => ({ kind: "paragraph", blockId: id, text, claimIds });
const D = (id: string, mermaid: string, claimIds: string[] = []): WikiBlock => ({ kind: "diagram", blockId: id, mermaid, claimIds });

interface Def { id: string; kind: Kind; title: string; summary: string; parent?: string; order: number; repos: string[]; blocks: WikiBlock[]; claims: ClaimDef[]; notes?: WikiShownNote[]; flagged?: boolean; writtenAgo: number }

const DEFS: Def[] = [
  { id: "overview", kind: "overview", title: "Product overview", order: 0, repos: [...REPOS], writtenAgo: 1,
    summary: "Beacon lets field service companies book site visits, send a technician, and bill the customer. The code is four repos, built at different times and in four languages.",
    claims: [
      claim("c-web-1", "Customers book and pay in beacon-web, a React app.", "beacon-web", "src/routes/index.tsx", 8, 40),
      claim("c-web-2", "beacon-web talks to beacon-api over REST under /v2.", "beacon-web", "src/lib/apiClient.ts", 14, 31),
      claim("c-api-1", "beacon-api serves the REST API from src/server.ts.", "beacon-api", "src/server.ts", 22, 58),
      claim("c-agents-1", "beacon-agents runs Python services that match visits to technicians.", "beacon-agents", "matcher/service.py", 18, 64, { source: "changed" }),
      claim("c-legacy-1", "beacon-legacy still makes invoices.", "beacon-legacy", "app/Jobs/CreateInvoice.php", 31, 58),
    ],
    blocks: [
      H("h-glance", "The system at a glance"),
      P("p-glance-1", "Customers book and pay in beacon-web, a React app. It talks to one backend, beacon-api, over REST under `/v2`.", ["c-web-1", "c-web-2", "c-api-1"]),
      P("p-glance-2", "Two things sit beside the API. beacon-agents runs Python services that match visits to technicians. beacon-legacy, the original PHP app, still makes invoices.", ["c-agents-1", "c-legacy-1"]),
      D("d-arch", "flowchart LR\n  web --> api\n  api --> agents\n  legacy --> api", ["c-web-2"]),
      H("h-docs", "Where the docs and the code disagree"),
      P("p-docs-1", "`docs/architecture.md` in beacon-api says invoices are made in the API. The code shows beacon-legacy still makes them.", ["c-legacy-1"]),
    ] },
  { id: "connections", kind: "connections", title: "How the repos connect", order: 1, repos: ["beacon-web", "beacon-api", "beacon-agents"], writtenAgo: 2,
    summary: "Two links join the repos. Each one is cited on both sides. A link seen on only one side is dropped.",
    claims: [
      claim("c-link-1", "beacon-web calls beacon-api under /v2.", "beacon-web", "src/lib/apiClient.ts", 14, 31),
      claim("c-link-2", "beacon-api sends match jobs on the visit-match queue.", "beacon-api", "src/queue/publish.ts", 12, 30),
    ],
    blocks: [H("h-links", "The links"), P("p-links-1", "beacon-web calls beacon-api under `/v2`.", ["c-link-1"]), P("p-links-2", "beacon-api sends match jobs to beacon-agents on the `visit-match` queue.", ["c-link-2"])] },
  { id: "glossary", kind: "glossary", title: "Glossary", order: 2, repos: ["beacon-api"], writtenAgo: 2, summary: "Words the code uses, and where each one is defined.",
    claims: [claim("c-visit", "A visit is one booked trip by a technician to a site.", "beacon-api", "src/db/schema/visits.ts", 5, 38)],
    blocks: [H("h-terms", "Terms"), P("p-visit", "Visit: one booked trip by a technician to a site, stored in the `visits` table.", ["c-visit"])] },
  { id: "repo-beacon-api", kind: "repo", title: "beacon-api", order: 10, repos: ["beacon-api"], writtenAgo: 2, summary: "The main backend: visits, slots, sign in and payments.",
    claims: [claim("c-api-stack", "Node.js with Fastify on Postgres.", "beacon-api", "package.json", 1, 30)],
    blocks: [H("h-what", "What it is"), P("p-what", "Node.js with Fastify, on Postgres. Payments live in the billing module.", ["c-api-stack"])] },
  { id: "beacon-api--billing", kind: "module", title: "billing", parent: "repo-beacon-api", order: 0, repos: ["beacon-api"], writtenAgo: 2,
    summary: "Charges and refunds, and the webhook that tells the API the payment provider is done.",
    notes: [
      { noteId: "note-pending-1", text: "Always run the refund tests before changing refund.ts.", author: "Priya", createdAt: iso(3), approval: "pending" },
      { noteId: "note-approved-1", text: "The webhook secret is rotated by the platform team.", author: "Sam", createdAt: iso(5), file: { repo: "beacon-api", path: "src/billing/webhooks.ts" }, approval: "approved" },
    ],
    claims: [
      claim("c-charge", "Charges go through chargeCustomer.", "beacon-api", "src/billing/charge.ts", 42, 67),
      claim("c-refund", "Refunds go out to the payment provider and come back by webhook.", "beacon-api", "src/billing/refund.ts", 12, 40),
      claim("c-webhook", "The webhook handler is in webhooks.ts.", "beacon-api", "src/billing/webhooks.ts", 104, 139),
      claim("c-full", "Only full refunds work today.", "beacon-api", "src/billing/refund.ts", 12, 40, { source: "changed" }),
      claim("c-round", "Refund amounts are rounded to the nearest 5 cents.", "beacon-api", "src/billing/refund.ts", 20, 22, { flagged: true }),
      claim("c-gone", "Webhooks are retried three times.", "beacon-api", "src/billing/webhooks.ts", 150, undefined, { source: "not_found" }),
    ],
    blocks: [
      H("h-does", "What it does"),
      P("p-does-1", "Charges go through `chargeCustomer`. Refunds go out to the payment provider and come back by webhook.", ["c-charge", "c-refund", "c-webhook"]),
      P("p-does-2", "Only full refunds work today. A partial refund is rejected before it reaches the provider.", ["c-full"]),
      P("p-does-3", "Refund amounts are rounded to the nearest 5 cents.", ["c-round"]),
      P("p-does-4", "Webhooks are retried three times.", ["c-gone"]),
      H("h-files", "Main files", 3),
      P("p-files", "`src/billing/charge.ts` starts a charge.\n`src/billing/refund.ts` starts a full refund.", ["c-charge", "c-refund"]),
    ] },
  { id: "repo-beacon-agents", kind: "repo", title: "beacon-agents", order: 20, repos: ["beacon-agents"], writtenAgo: 2, flagged: true, summary: "Background services: technician matching and visit summaries.",
    claims: [claim("c-ag-1", "Python 3.11 services.", "beacon-agents", "matcher/service.py", 18, 64, { source: "changed" }), claim("c-ag-2", "Visit summaries run in summaries/worker.py.", "beacon-agents", "summaries/worker.py", 9, 41, { source: "changed" })],
    blocks: [H("h-what", "What it is"), P("p-what", "Python 3.11 services. Summaries run in `summaries/worker.py`.", ["c-ag-1", "c-ag-2"])] },
  { id: "repo-beacon-legacy", kind: "repo", title: "beacon-legacy", order: 30, repos: ["beacon-legacy"], writtenAgo: 3, summary: "Old invoices and the admin back office.",
    claims: [claim("c-lg-1", "The original PHP app.", "beacon-legacy", "public/index.php", 1, 30)],
    blocks: [H("h-what", "What it is"), P("p-what", "The original PHP app.", ["c-lg-1"])] },
];

export type WikiVariant = "ready" | "none" | "building" | "stopped";
export interface WikiFixtureOptions { state?: WikiVariant }

const shown = (c: ClaimDef): WikiShownClaim => ({
  claimId: c.id, text: c.text, source: c.source ?? "found", flagged: c.flagged ?? false,
  citations: [{ repo: c.repo, path: c.path, commit: commitOf(c.repo), line: c.line, ...(c.lineEnd === undefined ? {} : { lineEnd: c.lineEnd }) }],
});
const counts = (def: Def) => ({ found: def.claims.filter((c) => (c.source ?? "found") === "found").length, changed: def.claims.filter((c) => c.source === "changed").length });

export function wikiIndex(project: string, options: WikiFixtureOptions = {}): WikiIndexResponse {
  const state = options.state ?? "ready";
  if (state === "none") return { project, state: "empty", pages: [] };
  if (state === "building") return { project, state: "empty", pages: [], lastBuild: { buildId: "build-0001", kind: "first", state: "running", startedAt: iso(0) } };
  return {
    project, state: "ready",
    pages: DEFS.map((def) => ({
      pageId: def.id, kind: def.kind, title: def.title, summary: def.summary, ...(def.parent === undefined ? {} : { parentId: def.parent }), order: def.order,
      repos: def.repos.map((repo) => ({ repo, commit: commitOf(repo) })), writtenAt: iso(def.writtenAgo), claims: counts(def), flagged: def.flagged ?? false,
    })),
    lastBuild: state === "stopped" ? { buildId: "build-0002", kind: "refresh", state: "stopped", startedAt: iso(1), endedAt: iso(1), stopReason: "cap" } : { buildId: "build-0001", kind: "first", state: "done", startedAt: iso(3), endedAt: iso(3) },
  };
}

export function wikiPage(project: string, id: string, options: WikiFixtureOptions = {}): WikiPageResponse | undefined {
  const def = DEFS.find((one) => one.id === id);
  if (def === undefined || (options.state ?? "ready") === "none" || options.state === "building") return undefined;
  return {
    project,
    page: { pageId: def.id, kind: def.kind, title: def.title, summary: def.summary, ...(def.parent === undefined ? {} : { parentId: def.parent }), repos: def.repos.map((repo) => ({ repo, commit: commitOf(repo) })), writtenAt: iso(def.writtenAgo), blocks: def.blocks, claims: def.claims.map(shown) },
    notes: def.notes ?? [], openFlags: def.claims.filter((c) => c.flagged).length + (def.flagged ? 1 : 0), trustLine: WIKI_TRUST_LINE,
  };
}

export function wikiSources(project: string, id: string, options: WikiFixtureOptions = {}): WikiSourcesResponse | undefined {
  const def = DEFS.find((one) => one.id === id);
  if (def === undefined || (options.state ?? "ready") === "none" || options.state === "building") return undefined;
  const files = new Map<string, WikiSourcesResponse["files"][number]>();
  for (const c of def.claims) {
    const key = `${c.repo}\u0000${c.path}`;
    const file = files.get(key) ?? { repo: c.repo, path: c.path, commit: commitOf(c.repo), ranges: [], claimIds: [] };
    file.ranges.push({ line: c.line, ...(c.lineEnd === undefined ? {} : { lineEnd: c.lineEnd }) });
    file.claimIds.push(c.id);
    files.set(key, file);
  }
  return { project, pageId: id, files: [...files.values()] };
}
