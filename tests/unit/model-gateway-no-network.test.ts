import { afterAll, beforeAll, expect, it } from "vitest";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns, { resolve4 as resolveFour } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { denyNetwork } from "./model-gateway-no-network.js";
// Sentinels keep the red control and guard mutants offline too.
const original4 = dns.resolve4; const original6 = dns.promises.resolve6;
Object.defineProperty(dns, "resolve4", { value: () => { throw new Error("unprotected DNS"); } });
dns.promises.resolve6 = () => { throw new Error("unprotected DNS"); };
syncBuiltinESMExports();
beforeAll(denyNetwork);
beforeAll(() => { afterAll(() => { dns.resolve4 = original4; dns.promises.resolve6 = original6; syncBuiltinESMExports(); }); });
it("blocks fetch, sockets, HTTP and DNS before network activity", () => {
  for (const attempt of [() => fetch("https://example.invalid"), () => net.connect(443, "example.invalid"), () => http.request("http://example.invalid"), () => https.get("https://example.invalid"), () => dns.lookup("example.invalid", () => undefined), () => dns.promises.lookup("example.invalid")]) expect(attempt).toThrow("NetworkAttempt");
});
it("blocks the specific DNS address APIs as well as generic resolve", () => {
  expect(() => dns.resolve4("example.invalid", () => undefined)).toThrow("NetworkAttempt");
  expect(() => dns.promises.resolve6("example.invalid")).toThrow("NetworkAttempt");
});
it("blocks named builtin imports as well as default imports", () => {
  expect(() => resolveFour("example.invalid", () => undefined)).toThrow("NetworkAttempt");
});
