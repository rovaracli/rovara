// WEB-1 (owner, 2026-11-02, option A): the browser may read the decision cards and press exactly the card routes the broker mounts (decisions/routes.ts PATH), nothing else under decisions.
import { describe, expect, it } from "vitest";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";

const CARD = "merge/6f1c0f0e-1111-4222-8333-444455556666";
const W = "/v1/web/decisions";

describe("web route rule: decisions", () => {
  it("allows the card list read", () => {
    expect(webRouteAllowed("GET", W)).toBe(true);
  });

  it("allows approve, reject and evidence-opened on a card, and only as POST", () => {
    for (const kind of ["setup_host", "approve_test_env", "confirm_env_change", "merge", "approve_plan"]) {
      for (const action of ["approve", "reject", "evidence-opened"]) {
        expect(webRouteAllowed("POST", `${W}/${kind}/abc_DEF-123/${action}`), `${kind} ${action}`).toBe(true);
        for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) expect(webRouteAllowed(method, `${W}/${kind}/abc_DEF-123/${action}`), `${method} ${kind} ${action}`).toBe(false);
      }
    }
    expect(webRouteAllowed("POST", `${W}/${CARD}/approve`)).toBe(true);
  });

  it("refuses every write on the list itself and every other read", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(webRouteAllowed(method, W), method).toBe(false);
    expect(webRouteAllowed("HEAD", W)).toBe(false);
  });

  it("refuses near-miss paths", () => {
    for (const path of [
      `${W}/`, `${W}//`, `${W}/${CARD}`, `${W}/${CARD}/`, `${W}/${CARD}/approve/`, `${W}/${CARD}/approve/extra`, `${W}/${CARD}/approve/../reject`,
      `${W}/${CARD}/Approve`, `${W}/${CARD}/approved`, `${W}/${CARD}/bulk`, `${W}/${CARD}/decide`, `${W}/${CARD}/evidence_opened`, `${W}/${CARD}/evidenceopened`,
      `${W}/approve`, `${W}/merge/approve`, `${W}/merge//approve`, `${W}/Merge/abc/approve`, `${W}/mer ge/abc/approve`, `${W}/merge-x/abc/approve`, `${W}/merge1/abc/approve`,
      `${W}/merge/abc.def/approve`, `${W}/merge/abc%2Fdef/approve`, `${W}/merge/abc/def/approve`, `${W}/merge/a b/approve`, `${W}/merge/${"a".repeat(151)}/approve`,
      `${W}/merge/abc/approve?x=1`, `${W}/merge/abc/approve#x`, `${W}/merge/abc\n/approve`, `${W}/merge/аbc/approve`, `${W}x`, `${W}s`, `/v1/web/decisionsx/merge/abc/approve`,
      `/v1/web/Decisions`, `/v1/web/decisions/../me`, `/v1/web/decisions/./`, `/v1/web/tasks/decisions`, `/v1/web/me/decisions`, `/v1/web//decisions`,
    ]) {
      for (const method of ["GET", "POST"]) expect(webRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("accepts the longest card id the broker accepts and no longer one", () => {
    expect(webRouteAllowed("POST", `${W}/merge/${"a".repeat(150)}/approve`)).toBe(true);
    expect(webRouteAllowed("POST", `${W}/merge/${"a".repeat(151)}/approve`)).toBe(false);
  });

  it("does not open anything else under the web boundary", () => {
    expect(webRouteAllowed("POST", "/v1/web/approvals/apr_aaaaaaaaaaaaaaaaaaaa/decide")).toBe(false);
    expect(webRouteAllowed("POST", "/v1/web/spend-requests/spr_aaaaaaaaaaaaaaaaaaaa/decide")).toBe(false);
    expect(webRouteAllowed("GET", "/v1/app/decisions")).toBe(false);
  });
});
