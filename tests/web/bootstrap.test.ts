// @vitest-environment jsdom
import type * as NonceModule from "get-nonce";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { getNonce, setNonce } from "get-nonce";
import { AppMeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { mountWebApp } from "../../packages/web/src/bootstrap.js";
const render = vi.hoisted(() => vi.fn());
vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => ({ render })) }));
vi.mock("get-nonce", async importOriginal => { const actual = await importOriginal<typeof NonceModule>();return { ...actual, setNonce: vi.fn(actual.setNonce) }; });
afterEach(() => { vi.clearAllMocks();document.head.innerHTML = "";document.body.innerHTML = ""; });
it("sets the nonce and disables Zod JIT before rendering or parsing API data", () => {
 document.head.innerHTML = '<meta name="csp-nonce" content="fixtureNonce123">';document.body.innerHTML = '<div id="root"></div>';
 render.mockImplementationOnce(() => {
 expect(z.config().jitless).toBe(true);expect(getNonce()).toBe("fixtureNonce123");
 expect(AppMeResponseReaderSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }).developer.name).toBe("Priya");
 });
 mountWebApp(window);expect(setNonce).toHaveBeenCalledWith("fixtureNonce123");expect(render).toHaveBeenCalledTimes(1);
});
it("refuses a missing application root with fixed text", () => { expect(() => mountWebApp(window)).toThrow("App root missing"); });

it("refuses to render when the CSP nonce is missing", () => { document.body.innerHTML = '<div id="root"></div>';expect(() => mountWebApp(window)).toThrow("App nonce missing");expect(render).not.toHaveBeenCalled(); });
