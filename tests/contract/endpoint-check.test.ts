// Plan 3 Task 12b: checkEndpointUrl, the one check an endpoint URL passes before the broker saves it or calls it (Task 24
// shares it). The refusals are the point: each one is a way to make the broker call something inside a network.
import { describe, expect, it, vi } from "vitest";
import { checkEndpointUrl, type ResolveHost } from "../../packages/broker/src/connections/endpoint-check.js";

const PUBLIC = ["52.1.2.3"];
const resolvesTo = (...addresses: string[]) => vi.fn<ResolveHost>(async () => addresses);

async function refusal(url: string, addresses: string[] = PUBLIC) {
  const resolve = resolvesTo(...addresses);
  const error = await checkEndpointUrl(url, resolve).then(() => undefined, (caught: { code?: string; message: string }) => caught);
  return { error, resolve };
}

describe("checkEndpointUrl", () => {
  it("accepts an https host that resolves only to public addresses, and says what it resolved", async () => {
    const resolve = resolvesTo("52.1.2.3", "2606:4700::6810:84e5");
    const checked = await checkEndpointUrl("https://mcp.acme.dev", resolve);
    expect(checked.url.href).toBe("https://mcp.acme.dev/");
    expect(checked.addresses).toEqual(["52.1.2.3", "2606:4700::6810:84e5"]);
    expect(resolve).toHaveBeenCalledWith("mcp.acme.dev");
    expect((await checkEndpointUrl("https://mcp.acme.dev:443/v1/mcp", resolvesTo(...PUBLIC))).url.pathname).toBe("/v1/mcp");
    expect((await checkEndpointUrl("https://MCP.Acme.DEV/", resolvesTo(...PUBLIC))).url.hostname).toBe("mcp.acme.dev");
  });

  it.each([
    ["http://x.example", "https"],
    ["https://10.0.0.5", "address"],
    ["https://[::1]", "address"],
    ["https://169.254.170.2", "address"],
    ["https://169.254.169.254/latest/meta-data", "address"],
    ["https://localhost", "local"],
    ["https://proxy.internal", "local"],
    ["https://db.local", "local"],
    ["https://app.localhost", "local"],
    ["https://u:p@x.example", "user"],
    ["https://u@x.example", "user"],
    ["https://x.example:4001", "port"],
    ["https://x.example:80", "port"],
    ["https://2130706433", "address"],
    ["https://0x7f.1", "address"],
    ["https://x.example.", "host"],
    ["https://singlelabel", "host"],
    ["https://*.acme.dev", "host"],
    ["https://github.io", "host"],
    ["ftp://x.example", "https"],
    ["not a url", "URL"],
    ["", "URL"],
  ])("refuses %s before resolving anything", async (url, reason) => {
    const { error, resolve } = await refusal(url);
    expect(error, url).toMatchObject({ code: "CONFIG_INVALID" });
    expect(error?.message).toContain(reason);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "10.1.2.3", "0.0.0.0", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.9", "172.31.255.255", "192.168.1.1", "224.0.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  ])("refuses a host that resolves to %s", async (address) => {
    const { error } = await refusal("https://mcp.acme.dev", [address]);
    expect(error, address).toMatchObject({ code: "CONFIG_INVALID" });
    expect(error?.message).toContain("not a public address");
  });

  it("refuses a host with even one non-public address among public ones", async () => {
    const { error } = await refusal("https://mcp.acme.dev", ["52.1.2.3", "10.1.2.3"]);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("fails closed when the host resolves to nothing, or the lookup fails", async () => {
    expect((await refusal("https://mcp.acme.dev", [])).error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("did not resolve") as string });
    const failing = await checkEndpointUrl("https://mcp.acme.dev", async () => { throw new Error("ENOTFOUND mcp.acme.dev with a token in it"); }).then(() => undefined, (caught: { code?: string; message: string }) => caught);
    expect(failing).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(failing?.message).not.toContain("token");
  });

  it("names neither the URL nor an address in a refusal, so a refusal can be shown and logged", async () => {
    for (const [url, addresses] of [["https://u:secretpass@x.example", PUBLIC], ["https://mcp.acme.dev/secret-path", ["10.9.8.7"]], ["https://10.9.8.7", PUBLIC]] as const) {
      const { error } = await refusal(url, [...addresses]);
      expect(error?.message, url).not.toMatch(/secretpass|secret-path|10\.9\.8\.7|x\.example|mcp\.acme/);
    }
  });
});
