import { afterAll, vi } from "vitest";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
/** Installed in beforeAll; restored after this file. No real transport, even loopback. */
export function denyNetwork(): void {
  const denied = (): never => { throw new Error("NetworkAttempt"); };
  const mocks: Array<{ mockRestore(): void }> = [vi.spyOn(globalThis, "fetch").mockImplementation(denied), vi.spyOn(net.Socket.prototype, "connect").mockImplementation(denied),
    vi.spyOn(http, "request").mockImplementation(denied), vi.spyOn(http, "get").mockImplementation(denied),
    vi.spyOn(https, "request").mockImplementation(denied), vi.spyOn(https, "get").mockImplementation(denied),
    vi.spyOn(dns, "lookup").mockImplementation(denied), vi.spyOn(dns, "resolve").mockImplementation(denied),
    vi.spyOn(dns.promises, "lookup").mockImplementation(denied), vi.spyOn(dns.promises, "resolve").mockImplementation(denied)];
  const resolvers = ["resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"] as const;
  for (const method of resolvers) {
    mocks.push(vi.spyOn(dns, method).mockImplementation(denied), vi.spyOn(dns.promises, method).mockImplementation(denied));
    mocks.push(vi.spyOn(dns.Resolver.prototype, method).mockImplementation(denied), vi.spyOn(dns.promises.Resolver.prototype, method).mockImplementation(denied));
  }
  mocks.push(vi.spyOn(dns, "lookupService").mockImplementation(denied), vi.spyOn(dns.promises, "lookupService").mockImplementation(denied));
  syncBuiltinESMExports();
  afterAll(() => { for (const mock of mocks) mock.mockRestore(); syncBuiltinESMExports(); });
}
