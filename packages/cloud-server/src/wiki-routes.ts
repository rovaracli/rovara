// Lead 4 slice W5 (DEC 254zi; designs-2026-11-17/wiki-and-just-answer-plan.md section 1.2, wiki-design-review.md fixes 5 and 6): the project Wiki tab's three reads, answered
// from Rovara Code's wiki read routes (slice W2, contract wiki-store.ts at 07cd73a5f on Code's local branch pr/l4-wiki-store) as the signed-in person, with their own token.
//
//   GET /v1/app/projects/{p}/wiki                        -> Code GET /v1/app/projects/{p}/wiki                        (WikiIndexResponseSchema)
//   GET /v1/app/projects/{p}/wiki/pages/{pageId}         -> Code GET /v1/app/projects/{p}/wiki/pages/{pageId}         (WikiPageResponseSchema)
//   GET /v1/app/projects/{p}/wiki/pages/{pageId}/sources -> Code GET /v1/app/projects/{p}/wiki/pages/{pageId}/sources (WikiSourcesResponseSchema)
//
// Rules:
//   - Code decides who may read: its live company and project role, on every call (any project role reads; anyone else, another company's project, a missing project or page
//     and a malformed name all get Code's one 404). Cloud adds no rule that could widen that. It only refuses earlier: a person Code names no company for gets NOT_IN_COMPANY, a
//     malformed project name, page id or query is refused without asking Code.
//   - The browser never names a company, a person or a Code id. The project name and page id (both pattern-checked) go only into Code's path; no query goes on.
//   - Every answer is rebuilt from known fields and must name THIS project (and, for a page and its sources, THIS page id). An answer for any other project or page, or one that
//     does not read (a field out of bounds, a control or format character, a claim a paragraph names that the page does not hold, a citation at a commit the page was not written
//     from), is refused whole: "unreadable is refusal".
//   - Wiki text is untrusted data. It is kept to plain characters here (a paragraph may hold new lines); the app draws it as text, never as markup.
//   - Code's refusals reach the app as Cloud's fixed sentences (WIKI_WORDS, the same as @agentx/contracts), never Code's own text and never an echo of the browser's input or the
//     cause. Until Code serves a route, its fixed unknown-route 404 reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-wiki.ts (its limits are repeated and a unit test pins them).
import { CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const WIKI_TRUST_LINE = "Written by Rovara from the code. It can be wrong. The code is the truth.";
export const WIKI_WORDS = Object.freeze({
  notFound: "project not found",
  noPage: "That wiki page is not there.",
  forbidden: "You can't read this project's wiki.",
  invalid: "the request is not valid",
  notYet: "The wiki isn't available on this Rovara yet.",
  unavailable: "The project wiki could not be read just now. Try again.",
});
const W = WIKI_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const WIKI_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", W.notFound),
  noPage: answer(404, "NOT_FOUND", W.noPage),
  forbidden: answer(403, "FORBIDDEN", W.forbidden),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = WIKI_ANSWERS;

/** Code's project names (AGENTX_NAME_PATTERN; a company-named project's id is the name plus a short suffix, which fits). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export const WIKI_PAGE_ID = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const WIKI_ID = /^[A-Za-z0-9_-]{4,64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const NEWLINES_OK = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const KINDS = ["overview", "repo", "module", "connections", "data_flow", "glossary", "patterns", "how_to_run", "docs"] as const;
const SOURCE_STATES = ["found", "changed", "not_found"] as const;
const BUILD_KINDS = ["first", "refresh", "nightly"] as const;
const BUILD_STATES = ["running", "done", "stopped", "failed"] as const;
const STOP_REASONS = ["cap", "person", "repo_unreadable", "no_ai_key", "unpriced_model", "failed"] as const;
const LIMITS = { pages: 300, blocks: 120, claims: 80, citations: 3, claimsPerBlock: 12, repos: 20, notes: 50, files: 300, ranges: 100 } as const;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const whole = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = <T extends string>(value: unknown, words: readonly T[]): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
/** A bounded string with no control or format characters (one line). */
const text = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && !CONTROL.test(value);
/** A bounded paragraph: new lines allowed, no other control or format character. */
const prose = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && NEWLINES_OK.test(value);
const slug = (value: unknown): value is string => typeof value === "string" && WIKI_PAGE_ID.test(value);
const wikiId = (value: unknown): value is string => typeof value === "string" && WIKI_ID.test(value);
const when = (value: unknown): value is string => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const repoName = (value: unknown): value is string => typeof value === "string" && PROJECT_NAME.test(value);
const commit = (value: unknown): value is string => typeof value === "string" && COMMIT.test(value);
const safePath = (value: unknown): value is string => text(value, 256) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || part === "");
const list = (value: unknown, max: number): unknown[] => { if (!Array.isArray(value) || value.length > max) throw new Unreadable(); return value; };

/** Not a readable answer: the whole read is refused, never a part of it. */
export class Unreadable extends Error {}
function need<T>(ok: boolean, value: T): T { if (!ok) throw new Unreadable(); return value; }
const opt = <T>(value: unknown, check: (one: unknown) => boolean, key: string): Record<string, T> => (value === undefined ? {} : { [key]: need(check(value), value as T) });
const rec = (value: unknown): Plain => need(plain(value), value as Plain);

const repoCommit = (value: unknown): Plain => { const v = rec(value); return { repo: need(repoName(v["repo"]), v["repo"]), commit: need(commit(v["commit"]), v["commit"]) }; };

/** Code's page list for THIS project, rebuilt from its known fields only; throws Unreadable on anything off. */
export function indexAnswer(value: unknown, project: string): Plain {
  const v = rec(value);
  need(v["project"] === project, undefined);
  const ids = new Set<string>();
  const last = v["lastBuild"] === undefined ? undefined : rec(v["lastBuild"]);
  return {
    project,
    state: need(oneOf(v["state"], ["empty", "ready"] as const), v["state"]),
    pages: list(v["pages"], LIMITS.pages).map((one) => {
      const p = rec(one);
      need(slug(p["pageId"]) && !ids.has(p["pageId"]), undefined);
      ids.add(p["pageId"] as string);
      const claims = rec(p["claims"]);
      return {
        pageId: p["pageId"], kind: need(oneOf(p["kind"], KINDS), p["kind"]), title: need(text(p["title"], 120), p["title"]), summary: need(text(p["summary"], 300, 0), p["summary"]),
        ...opt<string>(p["parentId"], slug, "parentId"), order: need(whole(p["order"], 0, 10_000), p["order"]),
        repos: list(p["repos"], LIMITS.repos).map(repoCommit), writtenAt: need(when(p["writtenAt"]), p["writtenAt"]),
        claims: { found: need(whole(claims["found"], 0, 100_000), claims["found"]), changed: need(whole(claims["changed"], 0, 100_000), claims["changed"]) },
        flagged: need(typeof p["flagged"] === "boolean", p["flagged"]),
      };
    }),
    ...(last === undefined ? {} : {
      lastBuild: {
        buildId: need(wikiId(last["buildId"]), last["buildId"]), kind: need(oneOf(last["kind"], BUILD_KINDS), last["kind"]), state: need(oneOf(last["state"], BUILD_STATES), last["state"]),
        startedAt: need(when(last["startedAt"]), last["startedAt"]), ...opt<string>(last["endedAt"], when, "endedAt"), ...opt<string>(last["stopReason"], (r) => oneOf(r, STOP_REASONS), "stopReason"),
      },
    }),
  };
}

function citation(value: unknown, commits: ReadonlyMap<string, string>): Plain {
  const c = rec(value);
  const line = need(whole(c["line"], 1, 10_000_000), c["line"]) as number;
  const repo = need(repoName(c["repo"]), c["repo"]) as string;
  // A citation at a commit the page was not written from does not read.
  need(commits.get(repo) === c["commit"], undefined);
  return { repo, path: need(safePath(c["path"]), c["path"]), commit: c["commit"], line, ...(c["lineEnd"] === undefined ? {} : { lineEnd: need(whole(c["lineEnd"], line, 10_000_000), c["lineEnd"]) }) };
}

/** Code's page for THIS project and THIS page id, rebuilt from its known fields only; throws Unreadable on anything off. */
export function pageAnswer(value: unknown, project: string, id: string): Plain {
  const v = rec(value);
  need(v["project"] === project && v["trustLine"] === WIKI_TRUST_LINE, undefined);
  const p = rec(v["page"]);
  need(p["pageId"] === id, undefined);
  const repos = list(p["repos"], LIMITS.repos).map(repoCommit);
  need(repos.length >= 1 && new Set(repos.map((one) => one["repo"])).size === repos.length, undefined);
  const commits = new Map(repos.map((one) => [one["repo"] as string, one["commit"] as string]));
  const claims = list(p["claims"], LIMITS.claims).map((one) => {
    const c = rec(one);
    const cites = list(c["citations"], LIMITS.citations);
    need(cites.length >= 1, undefined);
    return {
      claimId: need(wikiId(c["claimId"]), c["claimId"]) as string, text: need(text(c["text"], 600), c["text"]), source: need(oneOf(c["source"], SOURCE_STATES), c["source"]),
      citations: cites.map((cite) => citation(cite, commits)), flagged: need(typeof c["flagged"] === "boolean", c["flagged"]),
    };
  });
  const claimIds = new Set(claims.map((c) => c.claimId));
  need(claimIds.size === claims.length, undefined);
  const blockIds = new Set<string>();
  const blocks = list(p["blocks"], LIMITS.blocks).map((one) => {
    const b = rec(one);
    need(wikiId(b["blockId"]) && !blockIds.has(b["blockId"]), undefined);
    blockIds.add(b["blockId"] as string);
    const rests = (): string[] => { const ids = list(b["claimIds"], LIMITS.claimsPerBlock); return ids.map((c) => need(typeof c === "string" && claimIds.has(c), c) as string); };
    switch (b["kind"]) {
      case "heading": return { kind: "heading", blockId: b["blockId"], level: need(b["level"] === 2 || b["level"] === 3, b["level"]), text: need(text(b["text"], 200), b["text"]) };
      case "paragraph": return { kind: "paragraph", blockId: b["blockId"], text: need(prose(b["text"], 4_000), b["text"]), claimIds: rests() };
      case "diagram": return { kind: "diagram", blockId: b["blockId"], mermaid: need(prose(b["mermaid"], 4_000), b["mermaid"]), claimIds: rests() };
      default: throw new Unreadable();
    }
  });
  const noteIds = new Set<string>();
  const notes = list(v["notes"], LIMITS.notes).map((one) => {
    const n = rec(one);
    need(wikiId(n["noteId"]) && !noteIds.has(n["noteId"]), undefined);
    noteIds.add(n["noteId"] as string);
    const file = n["file"] === undefined ? undefined : rec(n["file"]);
    return {
      noteId: n["noteId"], text: need(prose(n["text"], 2_000), n["text"]), author: need(text(n["author"], 100), n["author"]), createdAt: need(when(n["createdAt"]), n["createdAt"]),
      ...(file === undefined ? {} : { file: { repo: need(repoName(file["repo"]), file["repo"]), path: need(safePath(file["path"]), file["path"]) } }),
      approval: need(oneOf(n["approval"], ["pending", "approved"] as const), n["approval"]),
    };
  });
  return {
    project,
    page: {
      pageId: id, kind: need(oneOf(p["kind"], KINDS), p["kind"]), title: need(text(p["title"], 120), p["title"]), summary: need(text(p["summary"], 300, 0), p["summary"]),
      ...opt<string>(p["parentId"], slug, "parentId"), repos, writtenAt: need(when(p["writtenAt"]), p["writtenAt"]), blocks, claims,
    },
    notes, openFlags: need(whole(v["openFlags"], 0, 100_000), v["openFlags"]), trustLine: WIKI_TRUST_LINE,
  };
}

/** Code's cited-files answer for THIS project and THIS page id. */
export function sourcesAnswer(value: unknown, project: string, id: string): Plain {
  const v = rec(value);
  need(v["project"] === project && v["pageId"] === id, undefined);
  return {
    project, pageId: id,
    files: list(v["files"], LIMITS.files).map((one) => {
      const f = rec(one);
      return {
        repo: need(repoName(f["repo"]), f["repo"]), path: need(safePath(f["path"]), f["path"]), commit: need(commit(f["commit"]), f["commit"]),
        ranges: list(f["ranges"], LIMITS.ranges).map((r) => { const range = rec(r); const line = need(whole(range["line"], 1, 10_000_000), range["line"]) as number; return { line, ...(range["lineEnd"] === undefined ? {} : { lineEnd: need(whole(range["lineEnd"], line, 10_000_000), range["lineEnd"]) }) }; }),
        claimIds: list(f["claimIds"], LIMITS.claims).map((c) => need(wikiId(c), c)),
      };
    }),
  };
}

type Kind = "index" | "page" | "sources";
/** Code's refusal in Cloud's fixed words. Only Code's exact unknown-route 404 means "not on Code yet"; any other 404 is "not found". */
export function wikiRefusal(kind: Kind, error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404) return body?.["code"] === "NOT_FOUND" && body["message"] === "route not found" ? A.notYet : kind === "index" ? A.notFound : A.noPage;
  if (error.status === 403) return A.forbidden;
  if (error.status === 400) return A.invalid;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
async function fromCode(context: RouteContext, kind: Kind, path: string): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path) };
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return { refusal: wikiRefusal(kind, error) };
    throw error;
  }
}

/** The project in the path, after Code's access check names the person's company now; or the route's refusal. */
async function scope(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const project = context.params[0];
  if (project === undefined || !PROJECT_NAME.test(project)) return { refusal: A.notFound };
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (error instanceof CodeError) return { refusal: A.unavailable };
    throw error;
  }
  return refused(who) ? { refusal: who } : { project };
}

const wikiPath = (project: string, tail = "") => `/v1/app/projects/${encodeURIComponent(project)}/wiki${tail}`;

/** Rebuild Code's answer, or the route's one "couldn't be read" answer. */
function rebuilt(build: () => Plain): RouteAnswer {
  try { return { status: 200, body: build() }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
}

export const WIKI_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki$/u,
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      if ([...context.query.keys()].length > 0) return A.invalid;
      const got = await fromCode(context, "index", wikiPath(at.project));
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => indexAnswer(got.value, at.project));
    },
  },
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)$/u,
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const id = context.params[1];
      if (id === undefined || !WIKI_PAGE_ID.test(id) || [...context.query.keys()].length > 0) return A.invalid;
      const got = await fromCode(context, "page", wikiPath(at.project, `/pages/${encodeURIComponent(id)}`));
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => pageAnswer(got.value, at.project, id));
    },
  },
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/sources$/u,
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const id = context.params[1];
      if (id === undefined || !WIKI_PAGE_ID.test(id) || [...context.query.keys()].length > 0) return A.invalid;
      const got = await fromCode(context, "sources", wikiPath(at.project, `/pages/${encodeURIComponent(id)}/sources`));
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => sourcesAnswer(got.value, at.project, id));
    },
  },
];
