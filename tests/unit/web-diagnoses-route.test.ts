// Fix with agent (switch `fd`): the browser may start a diagnosis and read one, and nothing else under diagnoses (no deep tier, no "Apply this change"). Sessions already carry the Ask routes.
import { describe, expect, it } from "vitest";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";

const ID = "dgn_0123456789abcdefghij";
const W = "/v1/web/diagnoses";

describe("web route rule: diagnoses", () => {
  it("allows the start (POST) and the read of one diagnosis (GET), and nothing else", () => {
    expect(webRouteAllowed("POST", W)).toBe(true);
    expect(webRouteAllowed("GET", `${W}/${ID}`)).toBe(true);
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) expect(webRouteAllowed(method, W), method).toBe(false);
    for (const method of ["POST", "HEAD", "PUT", "PATCH", "DELETE"]) expect(webRouteAllowed(method, `${W}/${ID}`), method).toBe(false);
  });

  it("refuses the deep tier, apply and near-miss paths", () => {
    for (const path of [
      `${W}/${ID}/deep`, `${W}/${ID}/propose`, `${W}/${ID}/`, `${W}/`, `${W}/${ID.slice(0, -1)}`, `${W}/${ID}a`, `${W}/DGN_0123456789abcdefghij`, `${W}/dgn_0123456789ABCDEFGHIJ`,
      `${W}/${ID}/../me`, `${W}/../me`, `${W}x`, `/v1/web/Diagnoses`, `/v1/web/me/diagnoses`, `/v1/web//diagnoses`, `${W}/dgn_0123456789abcdefghi%2F`,
    ]) {
      for (const method of ["GET", "POST"]) expect(webRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
