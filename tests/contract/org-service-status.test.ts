import { expect, it } from "vitest";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
it("B35 org service status permits cookie reads but no writes or broad admin family", () => {
 for (const method of ["GET", "HEAD"]) expect(webRouteAllowed(method, "/v1/web/org/service-status")).toBe(true);
 for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(webRouteAllowed(method, "/v1/web/org/service-status")).toBe(false);
 expect(webRouteAllowed("GET", "/v1/web/admin/health")).toBe(false);
});
