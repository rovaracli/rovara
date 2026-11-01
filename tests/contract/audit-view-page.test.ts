// tests/contract/audit-view-page.test.ts
// Task 13 of the Audit Ledger plan: the read-only audit page behind the browser sign-in (I13). `GET /v1/app/audit/view` shows
// the ledger's status, its records with names, paging, an export form and the limits copy; `POST /v1/app/audit/view/export`
// starts an export. The session is the review cookie (`__Host-agentx_review_session`), re-read on every request, and the org is the
// member's own. The bench is Task 12's (FakeDynamoDb for every table, the real appender, a fake KMS and intake queue); the
// page is called directly with a session lookup the test controls, and a last group goes through the broker's handler.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LIMITS_COPY, auditOperatorId, AuditEventInputSchema, auditEventId, agentXError, type AuditEventInput, type OrgRole } from "@agentx/contracts";
import { appendEvent } from "../../packages/broker/src/audit/appender.js";
import { eraseAuditSubject } from "../../packages/broker/src/audit/erase.js";
import { auditExportId, exportObjectKey } from "../../packages/broker/src/audit/export.js";
import { AUDIT_VIEW_EXPORT_PATH, AUDIT_VIEW_PATH, createAuditViewPage, isAuditViewPath, type AuditViewCaller } from "../../packages/broker/src/audit/view-page.js";
import { AUDIT_ORG_FORBIDDEN } from "../../packages/broker/src/audit/routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { CSRF_COOKIE, SESSION_COOKIE, escapeHtml, signInLocation, type WebResponse } from "../../packages/broker/src/aws/web-session.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { A, B, LEDGER, SEALS, at, iso } from "../support/audit-anchor-harness.js";
import { C, KEYS, STATE, world, type Bench } from "../support/audit-routes-bench.js";
import { localSigner } from "../support/developer-fakes.js";
import { seedMembership } from "../support/developer-task-broker.js";

const ORIGIN = "https://rovara.test";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CSRF = "c".repeat(43);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- calling the page -----------------------------------------------------------------------------------------------------

/** The session lookup the page is given: the member the cookie stands for right now (a test changes it between two loads). */
interface Session { current: AuditViewCaller | undefined }
const memberOf = (orgId: string, orgRole: OrgRole, developerId = "dev_1"): AuditViewCaller => ({ developerId, orgId, orgRole });

let requests = 0;
const nextRequestId = (): string => `page-req-${String(++requests)}`;

function pageOf(b: Bench, session: Session, options: { ledger?: Bench["deps"] | undefined } = {}) {
  const handle = createAuditViewPage({
    origin: ORIGIN,
    authenticateSession: async (sessionId) => (sessionId === SESSION ? session.current : undefined),
    ledger: "ledger" in options ? options.ledger : b.deps,
  });
  const call = (request: Omit<AdaptedHttpRequest, "requestId"> & { requestId?: string }): Promise<WebResponse> =>
    handle({ requestId: nextRequestId(), ...request }, new URL(request.path, ORIGIN));
  const cookies = (parts: { session?: boolean; csrf?: string | false } = {}): string =>
    [parts.session === false ? undefined : `${SESSION_COOKIE}=${SESSION}`, parts.csrf === false ? undefined : `${CSRF_COOKIE}=${parts.csrf ?? CSRF}`].filter((part) => part !== undefined).join("; ");
  const get = (path: string, headers: Record<string, string> = {}): Promise<WebResponse> => call({ method: "GET", path, headers: { cookie: cookies({ csrf: false }), ...headers } });
  const post = (fields: Record<string, string>, options: { headers?: Record<string, string>; csrf?: string | false; session?: boolean; origin?: string | false } = {}): Promise<WebResponse> =>
    call({
      method: "POST",
      path: AUDIT_VIEW_EXPORT_PATH,
      headers: {
        cookie: cookies({ session: options.session ?? true, csrf: options.csrf ?? CSRF }),
        "content-type": "application/x-www-form-urlencoded",
        ...(options.origin === false ? {} : { origin: options.origin ?? ORIGIN }),
        ...options.headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  return { call, get, post };
}

const admin = (orgId = A): Session => ({ current: memberOf(orgId, "admin") });
const exportForm = (requestId = "form-request-1", extra: Record<string, string> = {}): Record<string, string> => ({ csrf: CSRF, requestId, fromSeq: "1", toSeq: "12", ...extra });

const LEDGER_TABLES = new Set([LEDGER, SEALS, KEYS]);
const ledgerOperations = (b: Bench, since = 0) => b.h.operations.slice(since).filter((operation) => LEDGER_TABLES.has(operation.table));
const queued = (b: Bench): AuditEventInput[] => b.sqs.queue.map((message) => JSON.parse(message.body) as AuditEventInput);
const exportItems = (b: Bench) => b.h.db.find((item) => String(item.pk).includes("#AUDIT_EXPORT#"));
const exportMetaKey = (orgId: string, exportId: string) => ({ pk: `ORG#${orgId}#AUDIT_EXPORT#${exportId}`, sk: "META" });

function finishExport(b: Bench, orgId: string, exportId: string, patch: Record<string, unknown> = {}): void {
  const item = b.h.db.get(exportMetaKey(orgId, exportId))!;
  b.h.db.set({
    ...item,
    status: "ready",
    completedAt: iso(b.h.clock.now),
    expiresAt: iso(b.h.clock.now + 6 * 86_400_000),
    objectKey: exportObjectKey(orgId, exportId, "0123456789abcdef"),
    summary: { fromSeq: 1, toSeq: 12, records: 12 },
    ...patch,
  });
}

const nonceOf = (response: WebResponse): string => /style-src 'nonce-([^']+)'/.exec(response.headers["content-security-policy"] ?? "")?.[1] ?? "";
const requestIdOf = (html: string): string => /name="requestId" value="([^"]*)"/.exec(html)?.[1] ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- who may see the page -------------------------------------------------------------------------------------------------

describe("the page's paths", () => {
  it("claims exactly the view page and its export", () => {
    expect(isAuditViewPath("/v1/app/audit/view")).toBe(true);
    expect(isAuditViewPath("/v1/app/audit/view/export")).toBe(true);
    for (const other of ["/v1/app/audit/views", "/v1/app/audit/view/export/x", "/v1/app/audit", "/v1/dev/audit/view", "/v1/app/audit/view/"]) expect(isAuditViewPath(other)).toBe(false);
    expect(AUDIT_VIEW_PATH).toBe("/v1/app/audit/view");
    expect(AUDIT_VIEW_EXPORT_PATH).toBe("/v1/app/audit/view/export");
  });
});

describe("sign-in", () => {
  it("sends a request with no session cookie to the browser sign-in and back, reading nothing", async () => {
    const b = await world();
    const before = b.h.operations.length;
    const { call } = pageOf(b, admin());
    const response = await call({ method: "GET", path: AUDIT_VIEW_PATH, headers: {} });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(signInLocation("/v1/app/audit/view"));
    expect(response.headers.location).toBe("/v1/auth/browser/authorize?return_to=%2Fv1%2Fapp%2Faudit%2Fview");
    expect(response.body).toBe("");
    expect(b.h.operations.length).toBe(before);
    expect(b.sqs.offered()).toBe(0);
  });

  it("sends a session the store does not know (ended, revoked, forged) to sign-in too", async () => {
    const b = await world();
    const before = b.h.operations.length;
    const { get } = pageOf(b, { current: undefined });
    const response = await get(AUDIT_VIEW_PATH);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(signInLocation("/v1/app/audit/view"));
    expect(ledgerOperations(b, before)).toStrictEqual([]);
  });

  it("sends a signed-out filtered view to the fixed sign-in path, dropping the filters", async () => {
    const b = await world();
    const { call } = pageOf(b, admin());
    const response = await call({ method: "GET", path: `${AUDIT_VIEW_PATH}?action=pull_request.opened&limit=5`, headers: {} });
    expect(response.headers.location).toBe(signInLocation("/v1/app/audit/view"));
  });
});

describe("who may see it", () => {
  it("serves the page to an Auditor, who reads the log and starts an export (I2)", async () => {
    const b = await world();
    const { get, post } = pageOf(b, { current: memberOf(A, "auditor") });
    const shown = await get(AUDIT_VIEW_PATH);
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain("Person of");
    expect((await post(exportForm())).statusCode).not.toBe(403);
  });

  it("answers a contributor 403 with the exact text and reads and records nothing", async () => {
    const b = await world();
    const before = b.h.operations.length;
    const { get, post } = pageOf(b, { current: memberOf(A, "member") });
    const refused = await get(AUDIT_VIEW_PATH);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(escapeHtml(AUDIT_ORG_FORBIDDEN));
    expect(refused.body).not.toContain("Person of");
    const refusedPost = await post(exportForm());
    expect(refusedPost.statusCode).toBe(403);
    expect(b.h.operations.length).toBe(before);
    expect(b.sqs.offered()).toBe(0);
    expect(b.invocations).toStrictEqual([]);
  });

  it("lets an owner and an admin through", async () => {
    const b = await world();
    for (const role of ["owner", "admin"] as const) {
      const { get } = pageOf(b, { current: memberOf(A, role) });
      expect((await get(AUDIT_VIEW_PATH)).statusCode).toBe(200);
    }
  });

  it("shows an admin of org B only org B, never a record, name or id of org A", async () => {
    const b = await world();
    const { get } = pageOf(b, admin(B));
    const response = await get(`${AUDIT_VIEW_PATH}?limit=200`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`Person of ${B}`);
    expect(response.body).not.toContain(`Person of ${A}`);
    expect(response.body).not.toContain(A);
    expect(response.body).not.toContain("pr_12");
    // B's world holds three records: its own head, not A's.
    expect(response.body).toContain("Showing 3 records");
    // A's cursor names a sequence number and no org: it reads B's chain here.
    const pagedA = await pageOf(b, admin(A)).get(`${AUDIT_VIEW_PATH}?limit=2`);
    const cursor = /cursor=([A-Za-z0-9_-]+)/.exec(pagedA.body)?.[1];
    expect(cursor).toBeDefined();
    const withCursor = await get(`${AUDIT_VIEW_PATH}?limit=200&cursor=${cursor!}`);
    expect(withCursor.body).not.toContain(A);
    expect(withCursor.body).not.toContain("pr_12");
  });

  it("does not take an org from the request: an orgId parameter is refused and nothing is read", async () => {
    const b = await world();
    const before = b.h.operations.length;
    const { get } = pageOf(b, admin(B));
    const response = await get(`${AUDIT_VIEW_PATH}?orgId=${A}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(A);
    expect(response.body).not.toContain("orgId");
    expect(b.h.operations.length).toBe(before);
  });

  it("answers a page 404 where the install has no ledger, after the role check", async () => {
    const b = await world();
    const none = pageOf(b, admin(), { ledger: undefined });
    expect((await none.get(AUDIT_VIEW_PATH)).statusCode).toBe(404);
    const contributor = pageOf(b, { current: memberOf(A, "member") }, { ledger: undefined });
    expect((await contributor.get(AUDIT_VIEW_PATH)).statusCode).toBe(403);
  });

  it("re-reads the member on every request: an admin demoted between two loads gets 403 on the second", async () => {
    const b = await world();
    const session: Session = admin();
    const { get } = pageOf(b, session);
    expect((await get(AUDIT_VIEW_PATH)).statusCode).toBe(200);
    const events = queued(b).length;
    const operations = b.h.operations.length;
    session.current = memberOf(A, "member");
    const second = await get(AUDIT_VIEW_PATH);
    expect(second.statusCode).toBe(403);
    expect(second.body).not.toContain("Person of");
    expect(b.h.operations.length).toBe(operations);
    expect(queued(b).length).toBe(events);
    // And a member removed from the org (the session lookup answers nothing) is sent to sign in.
    session.current = undefined;
    expect((await get(AUDIT_VIEW_PATH)).statusCode).toBe(302);
  });
});

// ---- what the page shows --------------------------------------------------------------------------------------------------

describe("GET /v1/app/audit/view", () => {
  it("shows the limits copy at the top, then the status, then the records", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    const response = await get(AUDIT_VIEW_PATH);
    expect(response.statusCode).toBe(200);
    const paragraphs = AUDIT_LIMITS_COPY.split("\n\n");
    expect(paragraphs).toHaveLength(3);
    for (const paragraph of paragraphs) expect(response.body).toContain(escapeHtml(paragraph));
    const limits = response.body.indexOf(escapeHtml(paragraphs[0]!));
    const status = response.body.indexOf('id="status"');
    const records = response.body.indexOf('id="records"');
    expect(limits).toBeGreaterThan(-1);
    expect(limits).toBeLessThan(status);
    expect(status).toBeLessThan(records);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("shows how far the log is sealed, the latest independent time and the lock mode", async () => {
    const b = await world();
    for (const epoch of b.h.db.find((item) => String(item.pk).startsWith("EPOCH#"))) {
      b.h.db.set({ ...epoch, "stamp#digicert": { object: { key: "k", versionId: "v", lastModified: iso(at(0)), lockMode: "COMPLIANCE", retainUntil: iso(at(0)) }, genTime: "2026-10-20T12:07:09.000Z" } });
    }
    const { get } = pageOf(b, admin());
    const html = (await get(AUDIT_VIEW_PATH)).body;
    const status = html.slice(html.indexOf('id="status"'), html.indexOf('id="records"'));
    expect(status).toContain("Sealed through record 10 of 12");
    expect(status).toContain("2026-10-20 12:07:09 UTC");
    expect(status).toContain("COMPLIANCE");
    expect(status).not.toContain("governance");
  });

  it("says when no independent time exists yet", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    const html = (await get(AUDIT_VIEW_PATH)).body;
    const status = html.slice(html.indexOf('id="status"'), html.indexOf('id="records"'));
    expect(status).toContain("No independent time yet");
  });

  it("says plainly that a privileged administrator could remove the sealed copies, in governance mode only", async () => {
    const b = await world();
    for (const seal of b.h.db.find((item) => String(item.pk) === `SEALS#${A}`)) {
      const objects = seal.objects as { seal: Record<string, unknown> };
      b.h.db.set({ ...seal, objects: { ...objects, seal: { ...objects.seal, lockMode: "GOVERNANCE" } } });
    }
    const { get } = pageOf(b, admin());
    const status = (await get(AUDIT_VIEW_PATH)).body;
    expect(status).toContain("GOVERNANCE");
    expect(status).toContain("In governance mode, a privileged administrator could remove the sealed copies.");
    const compliance = await pageOf(b, admin(B)).get(AUDIT_VIEW_PATH);
    expect(compliance.body).not.toContain("privileged administrator");
  });

  it("lists each record with its time, actor and name, action, target, related ids and proof", async () => {
    const b = await world();
    await appendEvent(b.appender, AuditEventInputSchema.parse({
      eventId: auditEventId("approval.decided", "page-proof"),
      orgId: A,
      action: "approval.decided",
      actor: { kind: "member", id: "dev_1" },
      target: { kind: "approval", id: "apr_77" },
      occurredAt: iso(b.h.clock.now),
      related: ["task_9", "pr_44"],
      facts: { kind: "write", decision: "approve", subjectKind: "write" },
      proof: { kind: "fresh_sign_in", method: "email_code", authTime: iso(b.h.clock.now - 5000), sessionRef: "a".repeat(64) },
      details: [{ subject: "dev_1", fields: { name: "Maya Chen" } }],
    }));
    const { get } = pageOf(b, admin());
    const html = (await get(`${AUDIT_VIEW_PATH}?action=approval.decided`)).body;
    const row = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(row).toContain("approval.decided");
    expect(row).toContain("dev_1");
    expect(row).toContain("Maya Chen");
    expect(row).toContain("apr_77");
    expect(row).toContain("task_9");
    expect(row).toContain("pr_44");
    expect(row).toContain("fresh_sign_in");
    expect(row).toContain("email_code");
    expect(row).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    // The sealed details were opened for the org's own admin; no raw hashes or keys are shown.
    expect(row).not.toContain("sealedDetails");
  });

  it("shows an erased person's part as erased, not as an empty name", async () => {
    const b = await world();
    // The person's key is deleted: their part is erased in the reader's answer.
    for (const key of b.h.db.find((item) => String(item.sk).startsWith("SUBJECT#") && String(item.pk) === `ORG#${A}`)) b.h.db.delete(key.pk as string, key.sk as string);
    const { get } = pageOf(b, admin());
    const html = (await get(`${AUDIT_VIEW_PATH}?limit=2`)).body;
    expect(html).toContain("erased");
    expect(html).not.toContain(`Person of ${A}`);
  });

  it("after a real erasure (the tombstone and its event, not a deleted key), shows the person as erased and holds their name nowhere in the page, while another org's page keeps its own", async () => {
    const b = await world();
    await eraseAuditSubject(
      { documentClient: b.h.deps.documentClient, keysTable: KEYS, tableName: STATE, ...(b.deps.audit === undefined ? {} : { audit: b.deps.audit }), now: () => b.h.clock.now, log: () => undefined, eraseLearning: async () => undefined, purgeExports: async () => undefined },
      { orgId: A, developerId: "dev_1", by: { kind: "operator", id: auditOperatorId("https://staff-idp.example.test", "staff-1") }, reason: "Asked to be forgotten", requestId: "view-erase-1" },
    );
    const mine = (await pageOf(b, admin()).get(`${AUDIT_VIEW_PATH}?limit=200`)).body;
    expect(mine).toContain("erased");
    expect(mine).not.toContain(`Person of ${A}`);
    expect(mine).not.toContain("Asked to be forgotten");
    // The erasure's own event is not in the chain yet (it is in the outbox), and the page still renders every record.
    expect(mine).toContain("pr_1<");
    const theirs = (await pageOf(b, admin(B)).get(`${AUDIT_VIEW_PATH}?limit=200`)).body;
    expect(theirs).toContain(`Person of ${B}`);
    expect(theirs).not.toContain("erased");
  });

  it("pages with the cursor it gives, keeping the filters", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    const first = (await get(`${AUDIT_VIEW_PATH}?limit=5&action=pull_request.opened`)).body;
    expect(first).toContain("pr_1<");
    expect(first).not.toContain("pr_6<");
    const next = /href="([^"]*cursor=[^"]*)"/.exec(first)?.[1];
    expect(next).toBeDefined();
    const href = next!.replaceAll("&amp;", "&");
    expect(href.startsWith("/v1/app/audit/view?")).toBe(true);
    expect(href).toContain("action=pull_request.opened");
    expect(href).toContain("limit=5");
    const second = (await get(href)).body;
    expect(second).toContain("pr_6<");
    expect(second).not.toContain("pr_1<");
  });

  it("answers a bad range, cursor or filter with a plain 400 and no stack", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    for (const query of ["cursor=not-a-cursor", "fromSeq=9&toSeq=2", "from=yesterday", "limit=0", "fromSeq=abc"]) {
      const response = await get(`${AUDIT_VIEW_PATH}?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(response.body, query).toContain("Choose a range");
    }
    const unknown = await get(`${AUDIT_VIEW_PATH}?probe-parameter=1`);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain("probe-parameter");
  });

  it("answers an unreadable ledger 503 with a plain try-again message, never the error text", async () => {
    const b = await world();
    vi.spyOn(b.deps.documentClient, "send").mockRejectedValue(new Error("internal boom at reader.ts:12 secret-table-name"));
    const { get } = pageOf(b, admin());
    const response = await get(AUDIT_VIEW_PATH);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Try again shortly");
    expect(response.body).not.toContain("boom");
    expect(response.body).not.toContain("reader.ts");
    expect(response.body).not.toContain("secret-table-name");
  });

  it("answers other methods 405 with Allow", async () => {
    const b = await world();
    const { call } = pageOf(b, admin());
    for (const method of ["PUT", "DELETE", "PATCH", "POST"]) {
      const response = await call({ method, path: AUDIT_VIEW_PATH, headers: { cookie: `${SESSION_COOKIE}=${SESSION}` } });
      expect(response.statusCode, method).toBe(405);
      expect(response.headers.allow).toBe("GET");
    }
    const getExport = await call({ method: "GET", path: AUDIT_VIEW_EXPORT_PATH, headers: { cookie: `${SESSION_COOKIE}=${SESSION}` } });
    expect(getExport.statusCode).toBe(405);
    expect(getExport.headers.allow).toBe("POST");
  });
});

// ---- headers --------------------------------------------------------------------------------------------------------------

describe("headers", () => {
  it("sends exactly the private headers, with Referrer-Policy same-origin so the form's POST carries its Origin", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    const response = await get(AUDIT_VIEW_PATH);
    const nonce = nonceOf(response);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(response.headers).toStrictEqual({
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `${CSRF_COOKIE}=${response.headers["set-cookie"]!.split(";")[0]!.split("=")[1]!}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`,
    });
    // A fresh nonce each time, and the style element carries it.
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(nonceOf(await get(AUDIT_VIEW_PATH))).not.toBe(nonce);
  });

  it("never sends no-referrer (under it a browser sends Origin: null on the export form and the check refuses it)", async () => {
    const b = await world();
    const { get, post } = pageOf(b, admin());
    for (const response of [await get(AUDIT_VIEW_PATH), await post(exportForm("headers-1")), await post(exportForm("headers-2"), { csrf: "x" })]) {
      expect(response.headers["referrer-policy"]).toBe("same-origin");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toContain("form-action 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("sets a valid CSRF cookie, and keeps the one the browser already has", async () => {
    const b = await world();
    const { get, call } = pageOf(b, admin());
    const fresh = await get(AUDIT_VIEW_PATH);
    const issued = /__Host-agentx_review_csrf=([A-Za-z0-9_-]{32,64});/.exec(fresh.headers["set-cookie"] ?? "")?.[1];
    expect(issued).toBeDefined();
    expect(fresh.body).toContain(`name="csrf" value="${issued!}"`);
    const kept = await call({ method: "GET", path: AUDIT_VIEW_PATH, headers: { cookie: `${SESSION_COOKIE}=${SESSION}; ${CSRF_COOKIE}=${CSRF}` } });
    expect(kept.headers["set-cookie"]).toContain(`${CSRF_COOKIE}=${CSRF};`);
    expect(kept.body).toContain(`name="csrf" value="${CSRF}"`);
  });
});

// ---- escaping -------------------------------------------------------------------------------------------------------------

describe("every ledger value is text", () => {
  async function hostile(b: Bench): Promise<void> {
    b.h.clock.now += 1000;
    await appendEvent(b.appender, AuditEventInputSchema.parse({
      eventId: auditEventId("pull_request.opened", "hostile"),
      orgId: A,
      action: "pull_request.opened",
      actor: { kind: "member", id: "dev_<script>1" },
      target: { kind: "pull_request", id: "pr_\"><img src=x onerror=alert(1)>" },
      occurredAt: iso(b.h.clock.now),
      related: ["<script>alert('related')</script>", "x\" onmouseover=\"alert(2)"],
      facts: { number: 7 },
      details: [
        { subject: "dev_<script>1", fields: { name: "<script>alert(1)</script>", note: "\" onfocus=\"alert(3)\" autofocus=\"", "\"><svg onload=alert(4)>": "key", spoof: "invoice‮txt.exe", zero: "a​b⁦c⁩", lines: "one\ntwo\u0007" } },
      ],
    }));
  }

  it("renders <script>, attribute-breaking quotes and bidi overrides in a stored detail, actor, target and related id as inert text", async () => {
    const b = await world();
    await hostile(b);
    const { get } = pageOf(b, admin());
    const response = await get(`${AUDIT_VIEW_PATH}?limit=200`);
    expect(response.statusCode).toBe(200);
    const html = response.body;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain('" onmouseover=');
    expect(html).not.toContain('" onfocus=');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("dev_&lt;script&gt;1");
    expect(html).toContain("pr_&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;related&#39;)&lt;/script&gt;");
    expect(html).toContain("x&quot; onmouseover=&quot;alert(2)");
    // No control or bidi character reaches the page raw; each is shown as its code point.
    expect(html.replace(/[\n\r\t]/g, "")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(html).toContain("U+202E");
    expect(html).toContain("U+200B");
    expect(html).toContain("U+2066");
    expect(html).toContain("U+0007");
    // Newlines in a detail do not break the row.
    expect(html).not.toContain("one\ntwo");
  });

  it("escapes the same values in an export's status view and in paging links", async () => {
    const b = await world();
    await hostile(b);
    const { get } = pageOf(b, admin());
    const response = await get(`${AUDIT_VIEW_PATH}?limit=2&action=${encodeURIComponent("pull_request.opened")}&actorId=${encodeURIComponent('"><script>x</script>')}`);
    expect(response.body).not.toContain("<script");
    for (const [, href] of response.body.matchAll(/href="([^"]*)"/g)) {
      expect(href).not.toContain('"');
      expect(href).not.toContain("<");
    }
  });
});

// ---- recording the reads --------------------------------------------------------------------------------------------------

describe("each view is a recorded read", () => {
  it("records audit.read with via: page and the page's range and count, once per view, in the viewer's own org", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    await get(`${AUDIT_VIEW_PATH}?limit=3`);
    expect(queued(b)).toHaveLength(1);
    const [event] = queued(b);
    expect(event).toMatchObject({ action: "audit.read", orgId: A, actor: { kind: "member", id: "dev_1" }, facts: { fromSeq: 1, toSeq: 3, count: 3, via: "page" } });
    await get(AUDIT_VIEW_PATH);
    await get(AUDIT_VIEW_PATH);
    const events = queued(b);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
    for (const e of events) expect(e).toMatchObject({ action: "audit.read", orgId: A, facts: { via: "page" } });
  });

  it("records an empty page as 0 records, and does not record a refused or signed-out view", async () => {
    const b = await world();
    const { get, call } = pageOf(b, { current: memberOf(C, "admin") });
    expect((await get(AUDIT_VIEW_PATH)).statusCode).toBe(200);
    expect(queued(b).map((e) => [e.orgId, e.facts])).toStrictEqual([[C, { fromSeq: 0, toSeq: 0, count: 0, via: "page" }]]);
    b.sqs.queue.splice(0);
    await call({ method: "GET", path: AUDIT_VIEW_PATH, headers: {} });
    await pageOf(b, { current: memberOf(A, "member") }).get(AUDIT_VIEW_PATH);
    await get(`${AUDIT_VIEW_PATH}?fromSeq=5&toSeq=2`);
    expect(queued(b)).toStrictEqual([]);
  });

  it("still serves the page when the read cannot be recorded (best effort, as for the API)", async () => {
    const b = await world();
    b.sqs.mode = "throw";
    const original = b.h.deps.documentClient.send.bind(b.h.deps.documentClient) as (command: unknown) => Promise<unknown>;
    vi.spyOn(b.deps.documentClient, "send").mockImplementation((async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "PutCommand" && String((command as { input: { TableName?: string } }).input.TableName) === STATE) throw new Error("state down");
      return original(command);
    }) as never);
    const { get } = pageOf(b, admin());
    expect((await get(AUDIT_VIEW_PATH)).statusCode).toBe(200);
  });
});

// ---- the export form ------------------------------------------------------------------------------------------------------

describe("the export form", () => {
  it("carries a fresh uuid requestId as a hidden field each time the page loads, and posts to the export path", async () => {
    const b = await world();
    const { get } = pageOf(b, admin());
    const one = (await get(AUDIT_VIEW_PATH)).body;
    const two = (await get(AUDIT_VIEW_PATH)).body;
    expect(requestIdOf(one)).toMatch(UUID);
    expect(requestIdOf(two)).toMatch(UUID);
    expect(requestIdOf(one)).not.toBe(requestIdOf(two));
    expect(one).toContain('<form method="post" action="/v1/app/audit/view/export"');
    expect(one).toContain('name="fromSeq"');
    expect(one).toContain('name="toSeq"');
    expect(one).toContain('name="withDetails"');
    expect(one).not.toContain("<script");
  });

  it("starts the export, answers 303 to the export's own status view, and a double submit is the same export", async () => {
    const b = await world();
    const { get, post } = pageOf(b, admin());
    const requestId = requestIdOf((await get(AUDIT_VIEW_PATH)).body);
    const form = exportForm(requestId, { withDetails: "on" });
    const first = await post(form);
    const exportId = auditExportId(A, requestId);
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe(`/v1/app/audit/view?export=${exportId}`);
    expect(b.invocations).toHaveLength(1);
    expect(b.invocations[0]).toMatchObject({ orgId: A, exportId });
    expect(b.h.db.get(exportMetaKey(A, exportId))).toMatchObject({ status: "running", withDetails: true, range: { fromSeq: 1, toSeq: 12 }, requestedBy: { kind: "member", id: "dev_1" } });
    const second = await post(form);
    expect(second.statusCode).toBe(303);
    expect(second.headers.location).toBe(first.headers.location);
    expect(b.invocations).toHaveLength(1);
    expect(exportItems(b)).toHaveLength(1);
  });

  it("starts without details when the box is not ticked, and exports the viewer's own org only", async () => {
    const b = await world();
    const { post } = pageOf(b, admin(B));
    const response = await post(exportForm("b-1", { toSeq: "3" }));
    expect(response.statusCode).toBe(303);
    expect(b.h.db.get(exportMetaKey(B, auditExportId(B, "b-1")))).toMatchObject({ withDetails: false, orgId: B });
    expect(b.h.db.get(exportMetaKey(A, auditExportId(A, "b-1")))).toBeUndefined();
    expect(b.invocations.map((invocation) => invocation.orgId)).toStrictEqual([B]);
  });

  it("refuses a body with an org, or any field the form does not have", async () => {
    const b = await world();
    const { post } = pageOf(b, admin(B));
    for (const extra of [{ orgId: A }, { reason: "x" }, { surprise: "1" }]) {
      const response = await post(exportForm("extra", extra));
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      expect(response.body).not.toContain(Object.keys(extra)[0]!);
    }
    expect(b.invocations).toStrictEqual([]);
    expect(exportItems(b)).toStrictEqual([]);
  });

  it("refuses a range that is not a range with the range text, starting nothing", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    for (const range of [{ fromSeq: "0", toSeq: "5" }, { fromSeq: "9", toSeq: "2" }, { fromSeq: "", toSeq: "" }, { fromSeq: "a", toSeq: "b" }, { fromSeq: "1", toSeq: "200001" }, { fromSeq: "1.5", toSeq: "3" }, { fromSeq: "-1", toSeq: "3" }]) {
      const response = await post(exportForm("range", range));
      expect(response.statusCode, JSON.stringify(range)).toBe(400);
      expect(response.body).toContain("Choose a range of at most 200,000 records");
    }
    expect(b.invocations).toStrictEqual([]);
    expect(exportItems(b)).toStrictEqual([]);
  });

  it("refuses a missing or oversized requestId", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    expect((await post({ csrf: CSRF, fromSeq: "1", toSeq: "2" })).statusCode).toBe(400);
    expect((await post(exportForm("r".repeat(201)))).statusCode).toBe(400);
    expect(b.invocations).toStrictEqual([]);
  });

  it("answers 503 with a plain message when the export cannot be started, and nothing internal", async () => {
    const b = await world();
    vi.spyOn(b.deps.documentClient, "send").mockRejectedValue(new Error("internal boom at export.ts:99"));
    const { post } = pageOf(b, admin());
    const response = await post(exportForm("down"));
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Try again shortly");
    expect(response.body).not.toContain("boom");
    expect(response.body).not.toContain("export.ts");
  });
});

describe("the export POST's guards: each refusal starts nothing", () => {
  const expectNothingStarted = (b: Bench) => {
    expect(b.invocations).toStrictEqual([]);
    expect(exportItems(b)).toStrictEqual([]);
    expect(b.sqs.offered()).toBe(0);
  };

  it("refuses a post with no CSRF cookie", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    const response = await post(exportForm("c1"), { csrf: false });
    expect(response.statusCode).toBe(403);
    expectNothingStarted(b);
  });

  it("refuses a CSRF field of the right length in non-ASCII characters with the page, not a 500", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    const response = await post(exportForm("c1b", { csrf: "é".repeat(CSRF.length) }));
    expect(response.statusCode).toBe(403);
    expect(response.headers["referrer-policy"]).toBe("same-origin");
    expectNothingStarted(b);
  });

  it("refuses a post with no CSRF form field, or an empty one", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    const withoutField: Record<string, string> = exportForm("c2");
    delete withoutField.csrf;
    expect((await post(withoutField)).statusCode).toBe(403);
    expect((await post(exportForm("c2", { csrf: "" }))).statusCode).toBe(403);
    expectNothingStarted(b);
  });

  it("refuses a field that differs from the cookie, and a token of the wrong shape in both", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    expect((await post(exportForm("c3", { csrf: "d".repeat(43) }))).statusCode).toBe(403);
    expect((await post(exportForm("c3", { csrf: "short" }), { csrf: "short" })).statusCode).toBe(403);
    expect((await post(exportForm("c3", { csrf: `${CSRF}!` }), { csrf: `${CSRF}!` })).statusCode).toBe(403);
    expectNothingStarted(b);
  });

  it("refuses a foreign Origin, Origin: null and a missing Origin", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    for (const origin of ["https://evil.example", "null", "http://rovara.test", "https://rovara.test:8443", "https://rovara.test.evil.example", ORIGIN.toUpperCase()] as const) {
      expect((await post(exportForm("o1"), { origin })).statusCode, origin).toBe(403);
    }
    expect((await post(exportForm("o1"), { origin: false })).statusCode).toBe(403);
    expectNothingStarted(b);
  });

  it("accepts the cell's own Origin", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    expect((await post(exportForm("o2"), { origin: ORIGIN })).statusCode).toBe(303);
  });

  it("refuses a post with no session (to sign-in, not started), and one whose member is no longer an owner or admin", async () => {
    const b = await world();
    const signedOut = await pageOf(b, admin()).post(exportForm("s1"), { session: false });
    expect(signedOut.statusCode).toBe(401);
    const demoted = await pageOf(b, { current: memberOf(A, "member") }).post(exportForm("s2"));
    expect(demoted.statusCode).toBe(403);
    expect(demoted.body).toContain(escapeHtml(AUDIT_ORG_FORBIDDEN));
    const gone = await pageOf(b, { current: undefined }).post(exportForm("s3"));
    expect(gone.statusCode).toBe(401);
    expectNothingStarted(b);
  });

  it("says nothing about which guard refused", async () => {
    const b = await world();
    const { post } = pageOf(b, admin());
    const bodies = [await post(exportForm("g1"), { csrf: false }), await post(exportForm("g2"), { origin: "https://evil.example" })].map((response) => response.body.replace(/nonce="[^"]*"/, ""));
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain("evil.example");
  });
});

// ---- the export's status view ---------------------------------------------------------------------------------------------

describe("an export's status on the page", () => {
  const exportPath = (requestId: string) => `${AUDIT_VIEW_PATH}?export=${auditExportId(A, requestId)}`;

  async function started(b: Bench, session: Session = admin(), requestId = "status-1") {
    const handle = pageOf(b, session);
    await handle.post(exportForm(requestId));
    return { ...handle, exportId: auditExportId(A, requestId) };
  }

  it("shows a running export with no download link", async () => {
    const b = await world();
    const { get } = await started(b);
    const response = await get(exportPath("status-1"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="export"');
    expect(response.body).toContain("being prepared");
    expect(response.body).not.toContain("signed.test");
    expect(b.presigned).toStrictEqual([]);
  });

  it("shows a download link only for a ready export, and records the link as a read", async () => {
    const b = await world();
    const { get, exportId } = await started(b);
    finishExport(b, A, exportId);
    b.sqs.queue.splice(0);
    const response = await get(exportPath("status-1"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("is ready");
    const links = [...response.body.matchAll(/href="(https:\/\/signed\.test[^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
    expect(links).toHaveLength(1);
    expect(b.presigned).toHaveLength(1);
    expect(links[0]).toContain(b.presigned[0]!.key);
    expect(b.presigned[0]!.key).toContain(A);
    expect(response.body).toContain("12 records");
    expect(queued(b).map((e) => (e.facts as { via: string }).via).sort()).toStrictEqual(["export-download", "page"]);
    expect(new Set(queued(b).map((e) => e.eventId)).size).toBe(2);
  });

  it("shows no link for a failed or an expired export", async () => {
    const b = await world();
    const { get, exportId } = await started(b);
    b.h.db.set({ ...b.h.db.get(exportMetaKey(A, exportId))!, status: "failed", completedAt: iso(b.h.clock.now), failure: { code: "SOME_INTERNAL_CODE_X" } });
    const failed = await get(exportPath("status-1"));
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain("couldn&#39;t be built");
    expect(failed.body).not.toContain("signed.test");
    expect(failed.body).not.toContain("SOME_INTERNAL_CODE_X");
    finishExport(b, A, exportId, { expiresAt: iso(b.h.clock.now - 1000) });
    const expired = await get(exportPath("status-1"));
    expect(expired.body).toContain("has expired");
    expect(expired.body).not.toContain("signed.test");
    expect(b.presigned).toStrictEqual([]);
  });

  it("says try again shortly, with nothing internal, when the link cannot be signed", async () => {
    const b = await world();
    const { get, exportId } = await started(b);
    finishExport(b, A, exportId);
    b.presignFault.error = agentXError("RUNTIME_UNAVAILABLE", "internal: kms:Sign denied at presign.ts:44");
    const response = await get(exportPath("status-1"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("try again shortly");
    expect(response.body).not.toContain("kms:Sign");
    expect(response.body).not.toContain("presign.ts");
    expect(response.body).not.toContain("signed.test");
    // No link was handed out, so only the page view is recorded.
    expect(queued(b).map((e) => (e.facts as { via: string }).via)).toStrictEqual(["page"]);
  });

  it("answers an unknown or another org's export as not found, never its status", async () => {
    const b = await world();
    const otherOrg = pageOf(b, admin(B));
    await otherOrg.post(exportForm("b-status", { toSeq: "3" }));
    const theirs = auditExportId(B, "b-status");
    finishExport(b, B, theirs);
    const { get } = pageOf(b, admin(A));
    for (const id of [theirs, auditExportId(A, "never-made"), "aex_nothex", "<script>alert(1)</script>"]) {
      const response = await get(`${AUDIT_VIEW_PATH}?export=${encodeURIComponent(id)}`);
      expect(response.statusCode, id).toBe(200);
      expect(response.body, id).toContain("That export was not found");
      expect(response.body, id).not.toContain("signed.test");
      expect(response.body, id).not.toContain("<script>alert");
    }
    expect(b.presigned).toStrictEqual([]);
  });
});

// ---- through the broker's handler -----------------------------------------------------------------------------------------

describe("the broker's handler", () => {
  const ISSUER_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
  const CELL_ORIGIN = "https://abc123.execute-api.us-east-1.amazonaws.com";
  const T0 = Date.parse("2026-09-27T12:00:00.000Z");
  const signer = localSigner();
  const developerId = "d".repeat(64);
  const sessionId = "22222222-2222-4222-8222-222222222222";

  /** The broker over the bench's tables, with one developer who is `role` in org A and a browser sign-in session. */
  async function wired(role: OrgRole) {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const b = await world();
    const developer: DeveloperApiConfiguration = {
      issuer: ISSUER_URL, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin",
      channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      verifyAccessToken: developerTokenVerifier({ issuer: ISSUER_URL, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    };
    const { handler } = await createAdminBroker({ developer, extra: { documentClient: b.h.deps.documentClient, tableName: STATE, auditLedger: b.deps, audit: b.deps.audit } });
    seedMembership(b.h.db, developerId, { orgId: A, role });
    b.h.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800, reviewExpiresAt: T0 / 1000 + 604_800 });
    b.h.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x" });
    const send = async (method: string, path: string, options: { cookie?: string; origin?: string; body?: Record<string, string> } = {}) => {
      const response = await handler({
        version: "2.0",
        rawPath: path.split("?")[0],
        rawQueryString: path.split("?")[1] ?? "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", ...(options.cookie === undefined ? {} : { cookie: options.cookie }), ...(options.origin === undefined ? {} : { origin: options.origin }), ...(options.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
        ...(options.body === undefined ? {} : { body: new URLSearchParams(options.body).toString() }),
        requestContext: { requestId: nextRequestId(), http: { method } },
      });
      return response as unknown as WebResponse;
    };
    const session = `${SESSION_COOKIE}=${sessionId}`;
    return { b, send, session };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the page to a signed-in admin, sends a signed-out browser to sign-in, and records the view", async () => {
    const { b, send, session } = await wired("admin");
    const signedOut = await send("GET", AUDIT_VIEW_PATH);
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(signInLocation("/v1/app/audit/view"));
    const page = await send("GET", AUDIT_VIEW_PATH, { cookie: session });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`Person of ${A}`);
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(queued(b).map((e) => [e.action, e.orgId, e.actor.id, (e.facts as { via: string }).via])).toStrictEqual([["audit.read", A, developerId, "page"]]);
  });

  it("re-reads the membership: an admin demoted between two loads gets 403 on the second", async () => {
    const { b, send, session } = await wired("admin");
    expect((await send("GET", AUDIT_VIEW_PATH, { cookie: session })).statusCode).toBe(200);
    seedMembership(b.h.db, developerId, { orgId: A, role: "member" });
    const second = await send("GET", AUDIT_VIEW_PATH, { cookie: session });
    expect(second.statusCode).toBe(403);
    expect(second.body).toContain(escapeHtml(AUDIT_ORG_FORBIDDEN));
    expect(second.body).not.toContain("Person of");
  });

  it("starts an export from the form: the CSRF pair and the cell's Origin, then 303; and refuses the same post from another site", async () => {
    const { b, send, session } = await wired("owner");
    const csrfToken = "k".repeat(43);
    const cookie = `${session}; ${CSRF_COOKIE}=${csrfToken}`;
    const body = { csrf: csrfToken, requestId: "5a1c9a46-0f0e-4d0a-8f0e-1f2d3c4b5a69", fromSeq: "1", toSeq: "12" };
    const foreign = await send("POST", AUDIT_VIEW_EXPORT_PATH, { cookie, origin: "https://evil.example", body });
    expect(foreign.statusCode).toBe(403);
    expect(b.invocations).toStrictEqual([]);
    const own = await send("POST", AUDIT_VIEW_EXPORT_PATH, { cookie, origin: CELL_ORIGIN, body });
    expect(own.statusCode).toBe(303);
    expect(own.headers.location).toBe(`/v1/app/audit/view?export=${auditExportId(A, body.requestId)}`);
    expect(b.invocations).toHaveLength(1);
  });
});
