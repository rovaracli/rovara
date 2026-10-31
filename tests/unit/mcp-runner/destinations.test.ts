// Stdio MCP host redesign, task T7: the destinations an admin approves are resolved and checked like HTTP private servers: inside the install's private ranges, outside Rovara's network,
// never on the never-called list, IPv4 only.
import { describe, expect, it } from "vitest";
import { DestinationRefused, destinationResolver } from "../../../packages/broker/src/mcp-host/destinations.js";

const resolverOf = (answers: Record<string, string[]>, over: { installCidrs?: string[]; rovaraCidrs?: string[] } = {}) => destinationResolver({
  installCidrs: over.installCidrs ?? ["10.1.0.0/16"], rovaraCidrs: over.rovaraCidrs ?? ["10.42.0.0/16"], resolveHost: async (host) => { const found = answers[host]; if (found === undefined) throw new Error("nxdomain"); return found; },
});

describe("destinations", () => {
  it("resolves each destination to its IPv4 addresses, and keeps its port", async () => {
    const resolve = resolverOf({ "jira.corp.example": ["10.1.2.3", "10.1.2.4", "10.1.2.3"], "wiki.corp.example": ["10.1.9.9"] });
    expect(await resolve([{ host: "jira.corp.example", port: 443 }, { host: "wiki.corp.example", port: 8443 }])).toEqual([
      { host: "jira.corp.example", port: 443, addresses: ["10.1.2.3", "10.1.2.4"] }, { host: "wiki.corp.example", port: 8443, addresses: ["10.1.9.9"] },
    ]);
  });
  it("takes an IPv4 address as written, after the same checks, without a lookup", async () => {
    expect(await resolverOf({})([{ host: "10.1.5.5", port: 5432 }])).toEqual([{ host: "10.1.5.5", port: 5432, addresses: ["10.1.5.5"] }]);
    await expect(resolverOf({})([{ host: "192.168.1.1", port: 22 }])).rejects.toBeInstanceOf(DestinationRefused);
  });
  it("refuses a name that resolves outside the install's ranges, even if only one of its addresses does", async () => {
    await expect(resolverOf({ "a.example": ["10.2.0.1"] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
    await expect(resolverOf({ "a.example": ["10.1.0.1", "10.2.0.1"] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
  });
  it("refuses every address Rovara never calls, even when it is inside the ranges", async () => {
    const wide = { installCidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"] };
    for (const address of ["127.0.0.1", "169.254.169.254", "169.254.170.2", "100.100.100.200", "0.0.0.1", "224.0.0.1", "255.255.255.255"]) {
      await expect(resolverOf({ "a.example": [address] }, wide)([{ host: "a.example", port: 443 }]), address).rejects.toBeInstanceOf(DestinationRefused);
    }
    // a name that also answers with a never-called IPv6 form that carries an IPv4 address
    await expect(resolverOf({ "a.example": ["10.1.0.1", "::ffff:169.254.169.254"] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
    await expect(resolverOf({ "a.example": ["10.1.0.1", "64:ff9b::a9fe:a9fe"] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
  });
  it("refuses an address inside the network Rovara itself runs in", async () => {
    const overlapping = { installCidrs: ["10.0.0.0/8"], rovaraCidrs: ["10.42.0.0/16"] };
    await expect(resolverOf({ "a.example": ["10.42.0.5"] }, overlapping)([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
    expect(await resolverOf({ "a.example": ["10.43.0.5"] }, overlapping)([{ host: "a.example", port: 443 }])).toHaveLength(1);
  });
  it("refuses everything when the install set no ranges or a range that does not parse", async () => {
    await expect(resolverOf({ "a.example": ["10.1.0.1"] }, { installCidrs: [] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
    await expect(resolverOf({ "a.example": ["10.1.0.1"] }, { installCidrs: ["nonsense"] })([{ host: "a.example", port: 443 }])).rejects.toBeInstanceOf(DestinationRefused);
    expect(() => resolverOf({}, { rovaraCidrs: ["nonsense"] })).toThrow();
  });
  it("refuses a name that does not resolve, or resolves only to IPv6, with one fixed sentence that names nothing", async () => {
    for (const answers of [{}, { "a.example": ["fd00::1"] }, { "a.example": [] }]) {
      const error = await resolverOf(answers)([{ host: "a.example", port: 443 }]).catch((caught: unknown) => caught) as Error;
      expect(error).toBeInstanceOf(DestinationRefused);
      expect(error.message).toBe("This address is outside the ranges your install allows.");
    }
  });
  it("answers with nothing for no destinations", async () => {
    expect(await resolverOf({})([])).toEqual([]);
  });
});
