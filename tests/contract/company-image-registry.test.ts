// Company-approved images: where an image may come from. The registry allowlist (four built-in registries and the company's own list), by the host the list names and not by the shape of a typed name; the check that a
// registry's name resolves only to public addresses; the closed registry client (token host, redirects, caps); and the digest the resolver pins (the linux/arm64 platform manifest, not the index).
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANY_IMAGE_REGISTRIES, companyImageExtraRegistriesOf, companyImageExtraRegistry, companyImageRegistryRule } from "@agentx/cloud-contracts";
import { isPublicAddress, resolvesOnlyToPublicAddresses } from "../../packages/broker/src/test-env/public-address.js";
import { RegistryClientError, createRegistryClient } from "../../packages/broker/src/test-env/company-image-registry-client.js";
import { registryDigestResolver } from "../../packages/broker/src/test-env/company-image-resolver.js";
import { MANIFEST_TYPE, fakeLookup, fakeRegistry, hex, makeImage, makeIndex, PUBLIC_HOSTS, reply, text } from "../support/company-image-registry-fake.js";

describe("the registry allowlist", () => {
  it("allows the four built-in registries by exact name and refuses every look-alike", () => {
    expect(COMPANY_IMAGE_REGISTRIES.map((rule) => rule.name)).toEqual(["docker.io", "ghcr.io", "quay.io", "public.ecr.aws"]);
    for (const name of ["docker.io", "ghcr.io", "quay.io", "public.ecr.aws"]) expect(companyImageRegistryRule(name)?.name).toBe(name);
    const refused = [
      "GHCR.IO", "ghcr.io.", "ghcr.io:443", "user@ghcr.io", "ghcr.io@evil.example.com", "ghcr.io.evil.example.com", "evil-ghcr.io", "xghcr.io", "ghcr.io/", "https://ghcr.io", " ghcr.io", "ghcr.io\n",
      "registry-1.docker.io", "index.docker.io", "auth.docker.io", "docker.com",
      "127.0.0.1", "10.0.0.5", "169.254.169.254", "2130706433", "0x7f000001", "017700000001", "[::1]", "::1", "[2001:db8::1]", "localhost", "registry.internal", "ghcr。io", "ghcrㅤ.io", "xn--ghcr-9na.io", "", "a".repeat(300),
    ];
    for (const name of refused) expect(companyImageRegistryRule(name), name).toBeUndefined();
  });

  it("allows a company's extra registry only by exact host from that company's own list, and asks it at its own host", () => {
    expect(companyImageRegistryRule("registry.example.com")).toBeUndefined();
    expect(companyImageRegistryRule("registry.example.com", ["registry.other.com"])).toBeUndefined();
    expect(companyImageRegistryRule("registry.example.com", ["registry.example.com"])).toMatchObject({ name: "registry.example.com", apiHost: "registry.example.com", authHosts: ["registry.example.com"], blobHostSuffixes: [] });
    expect(companyImageRegistryRule("REGISTRY.example.com", ["registry.example.com"])).toBeUndefined();
    // A host that is not a valid registry host is never allowed, even when it is on the list.
    expect(companyImageRegistryRule("10.1.2.3", ["10.1.2.3"])).toBeUndefined();
  });

  it("accepts only plain public DNS names as an extra registry, and drops anything else from a damaged stored list", () => {
    expect(companyImageExtraRegistry("registry.example.com")).toBe("registry.example.com");
    for (const bad of ["Registry.example.com", "registry.example.com:5000", "https://registry.example.com", "registry.example.com/", "1.2.3.4", "localhost", "registry.corp.internal", "ghcr.io", "docker.io", "registry-1.docker.io", "nodots", "a b.example.com", "xn--e1afmkfd.example.com", 7, undefined, null]) {
      expect(companyImageExtraRegistry(bad), String(bad)).toBeUndefined();
    }
    expect(companyImageExtraRegistriesOf(["a.example.com", "A.example.com", "a.example.com", 3, "b.example.com", "10.0.0.1"])).toEqual(["a.example.com", "b.example.com"]);
    expect(companyImageExtraRegistriesOf("not a list")).toEqual([]);
    expect(companyImageExtraRegistriesOf(Array.from({ length: 30 }, (_, index) => `r${String(index)}.example.com`))).toHaveLength(8);
  });
});

describe("public addresses", () => {
  it("accepts global addresses and refuses every private, loopback, link-local, metadata, shared, documentation and mapped form", () => {
    for (const address of ["54.236.113.205", "8.8.8.8", "140.82.112.34", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"]) expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.5", "203.0.113.9", "224.0.0.1", "255.255.255.255", "240.0.0.1",
      "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "not an address", "", "1.2.3", "1.2.3.4.5", "999.1.1.1", "fe80::1%eth0",
    ]) expect(isPublicAddress(address), address).toBe(false);
  });

  it("is true only when the name resolves to public addresses ONLY (a name with one private answer, one that does not resolve and an IP literal are not)", async () => {
    const table = { "good.example.com": ["54.1.1.1", "2606:4700::1"], "mixed.example.com": ["54.1.1.1", "10.0.0.5"], "metadata.example.com": ["169.254.169.254"], "empty.example.com": [] };
    const { lookup } = fakeLookup(table);
    expect(await resolvesOnlyToPublicAddresses("good.example.com", lookup)).toBe(true);
    for (const host of ["mixed.example.com", "metadata.example.com", "empty.example.com", "missing.example.com", "10.0.0.5", "54.1.1.1", "::1"]) expect(await resolvesOnlyToPublicAddresses(host, lookup), host).toBe(false);
  });
});

describe("the registry client", () => {
  const image = makeImage();
  const base = { repository: "library/postgres", images: [image] };
  const client = (reg: ReturnType<typeof fakeRegistry>, table: Record<string, string[]> = PUBLIC_HOSTS, extra: string[] = [], registry = "docker.io") => createRegistryClient({ registry, extra, repository: "library/postgres", fetchImpl: reg.fetchImpl, lookup: fakeLookup(table).lookup });

  it("reads a manifest and a blob from the allowed registry, over https at the host the allowlist names, with the token only where it belongs", async () => {
    const reg = fakeRegistry({ ...base, auth: true });
    const c = client(reg);
    const manifest = await c.manifest(`sha256:${image.digest}`);
    expect(hex(manifest.bytes)).toBe(image.digest);
    expect(manifest.mediaType).toBe(MANIFEST_TYPE);
    expect(Buffer.from(await c.smallBlob(`sha256:${hex(image.config)}`, 1000)).toString()).toContain("arm64");
    const urls = reg.requests.map((request) => request.url);
    expect(urls[0]).toBe(`https://registry-1.docker.io/v2/library/postgres/manifests/sha256:${image.digest}`);
    expect(urls[1]).toMatch(/^https:\/\/auth\.docker\.io\/token\?scope=repository%3Alibrary%2Fpostgres%3Apull&service=registry$/u);
    expect(reg.requests.filter((request) => request.url.startsWith("https://registry-1.docker.io/")).map((request) => request.authorization)).toEqual([false, true, true]);
  });

  it("refuses a registry that is not allowed before any request, whatever the name looks like", async () => {
    const reg = fakeRegistry(base);
    for (const registry of ["ghcr.io.evil.example.com", "evil.example.com", "169.254.169.254", "GHCR.IO", "registry.example.com"]) {
      expect(() => client(reg, PUBLIC_HOSTS, [], registry), registry).toThrow(RegistryClientError);
    }
    expect(reg.requests).toEqual([]);
    expect(() => createRegistryClient({ registry: "docker.io", extra: [], repository: "../library/postgres", fetchImpl: reg.fetchImpl, lookup: fakeLookup(PUBLIC_HOSTS).lookup })).toThrow(RegistryClientError);
    expect(() => createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres?x=1", fetchImpl: reg.fetchImpl, lookup: fakeLookup(PUBLIC_HOSTS).lookup })).toThrow(RegistryClientError);
  });

  it("refuses an allowed registry whose name resolves to a private, loopback or metadata address, to a mix, or to nothing, and makes no request", async () => {
    for (const answer of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["54.236.113.205", "10.0.0.5"], []]) {
      const reg = fakeRegistry(base);
      const c = client(reg, { ...PUBLIC_HOSTS, "registry-1.docker.io": answer });
      await expect(c.manifest("18"), JSON.stringify(answer)).rejects.toMatchObject({ reason: "not_allowed" });
      expect(reg.requests).toEqual([]);
    }
    const reg = fakeRegistry(base);
    const { "registry-1.docker.io": _gone, ...withoutHost } = PUBLIC_HOSTS;
    void _gone;
    await expect(client(reg, withoutHost).manifest("18")).rejects.toMatchObject({ reason: "not_allowed" });
    expect(reg.requests).toEqual([]);
  });

  it("holds the token service to the registry's own auth hosts: a realm on another host, over http, an address or a port is refused and nothing is sent to it", async () => {
    for (const realm of ["https://evil.example.com/token", "http://auth.docker.io/token", "https://169.254.169.254/token", "https://auth.docker.io:8443/token", "https://user:pw@auth.docker.io/token", "https://auth.docker.io.evil.example.com/token"]) {
      const reg = fakeRegistry({ ...base, auth: true, realm });
      await expect(client(reg, { ...PUBLIC_HOSTS, "evil.example.com": ["54.9.9.9"], "auth.docker.io.evil.example.com": ["54.9.9.9"] }).manifest("18"), realm).rejects.toBeInstanceOf(RegistryClientError);
      expect(reg.requests.filter((request) => !request.url.startsWith("https://registry-1.docker.io/")), realm).toEqual([]);
    }
  });

  it("follows no redirect for a manifest, and for a blob only to an https host with one of the registry's blob suffixes that resolves publicly, without the token", async () => {
    // A redirect from the API host is refused for a manifest even when its target is an allowed blob host that would answer with a good manifest.
    const redirectedManifest = fakeRegistry(base);
    const followed: string[] = [];
    redirectedManifest.fetchImpl = async (url) => { followed.push(url); return url.startsWith("https://registry-1.docker.io/") ? reply(302, { location: "https://production.cloudflare.docker.com/x" }) : reply(200, { "content-type": MANIFEST_TYPE }, image.manifestBytes); };
    await expect(client(redirectedManifest).manifest("18")).rejects.toMatchObject({ reason: "unavailable" });
    expect(followed).toEqual(["https://registry-1.docker.io/v2/library/postgres/manifests/18"]);
    const good = fakeRegistry({ ...base, auth: true, blobRedirectTo: "https://production.cloudflare.docker.com", host: { apiHost: "registry-1.docker.io", authHost: "auth.docker.io", blobHost: "production.cloudflare.docker.com" } });
    const chunks: Uint8Array[] = [];
    for await (const chunk of client(good).blob(`sha256:${hex(image.layers[0]!)}`, 1000)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("layer one bytes");
    expect(good.requests.find((request) => request.url.startsWith("https://production.cloudflare.docker.com/"))?.authorization).toBe(false);
    for (const target of ["https://evil.example.com", "http://production.cloudflare.docker.com", "https://production.cloudflare.docker.com.evil.example.com", "https://169.254.169.254", "https://evil-docker.com", "https://docker.com"]) {
      const bad = fakeRegistry({ ...base, blobRedirectTo: target });
      const consume = async () => { for await (const chunk of client(bad, { ...PUBLIC_HOSTS, "evil.example.com": ["54.9.9.9"], "production.cloudflare.docker.com.evil.example.com": ["54.9.9.9"], "evil-docker.com": ["54.9.9.9"], "docker.com": ["54.9.9.9"] }).blob(`sha256:${hex(image.layers[0]!)}`, 1000)) void chunk; };
      await expect(consume(), target).rejects.toBeInstanceOf(RegistryClientError);
      expect(bad.requests.map((request) => new URL(request.url).host).filter((host) => host !== "registry-1.docker.io"), target).toEqual([]);
    }
    // A blob redirect to a host that RESOLVES privately is refused even when its suffix is allowed.
    const privateBlob = fakeRegistry({ ...base, blobRedirectTo: "https://production.cloudflare.docker.com" });
    const consume = async () => { for await (const chunk of client(privateBlob, { ...PUBLIC_HOSTS, "production.cloudflare.docker.com": ["10.1.1.1"] }).blob(`sha256:${hex(image.layers[0]!)}`, 1000)) void chunk; };
    await expect(consume()).rejects.toMatchObject({ reason: "not_allowed" });
  });

  it("caps what it reads: a manifest over 4 MiB, a blob over its limit, and a token reply that is too large", async () => {
    const big = fakeRegistry({ ...base, tags: { huge: { bytes: new Uint8Array(4 * 1024 * 1024 + 1), type: MANIFEST_TYPE } } });
    await expect(client(big).manifest("huge")).rejects.toMatchObject({ reason: "too_large" });
    const reg = fakeRegistry(base);
    const consume = async () => { for await (const chunk of client(reg).blob(`sha256:${hex(image.layers[1]!)}`, 5)) void chunk; };
    await expect(consume()).rejects.toMatchObject({ reason: "too_large" });
    const tokenHog = { ...fakeRegistry({ ...base, auth: true }), fetchImpl: async (url: string, init: { headers: Record<string, string> }) => (url.startsWith("https://auth.") ? reply(200, {}, "x".repeat(20_000)) : init.headers["authorization"] === undefined ? reply(401, { "www-authenticate": 'Bearer realm="https://auth.docker.io/token"' }) : reply(200)) };
    await expect(client(tokenHog as unknown as ReturnType<typeof fakeRegistry>).manifest("18")).rejects.toBeInstanceOf(RegistryClientError);
  });
});

describe("the digest the resolver pins", () => {
  const arm = makeImage({ arch: "arm64", salt: "arm" });
  const amd = makeImage({ arch: "amd64", salt: "amd" });
  const resolverFor = (reg: ReturnType<typeof fakeRegistry>, table: Record<string, string[]> = PUBLIC_HOSTS) => registryDigestResolver(reg.fetchImpl, fakeLookup(table).lookup);
  const postgres = { registry: "docker.io", repository: "library/postgres", tag: "18" };

  it("pins the linux/arm64 platform manifest of a multi-architecture tag, not the index: the digest the mirror copies and the worker pulls", async () => {
    const index = makeIndex([{ image: amd, os: "linux", architecture: "amd64" }, { image: arm, os: "linux", architecture: "arm64", variant: "v8" }, { image: arm, os: "unknown", architecture: "unknown", attestation: true }]);
    const reg = fakeRegistry({ repository: "library/postgres", images: [arm, amd], indexes: [index], tags: { "18": { bytes: index.bytes, type: "application/vnd.oci.image.index.v1+json" } } });
    const digest = await resolverFor(reg)(postgres);
    expect(digest).toBe(arm.digest);
    expect(digest).not.toBe(index.digest);
    expect(reg.requests.map((request) => request.url)).toEqual(["https://registry-1.docker.io/v2/library/postgres/manifests/18"]);
  });

  it("pins a single-image tag by the digest of the bytes it read, and only when its config says linux/arm64", async () => {
    const one = fakeRegistry({ repository: "library/postgres", images: [arm], tags: { "18": { bytes: arm.manifestBytes, type: MANIFEST_TYPE } } });
    expect(await resolverFor(one)(postgres)).toBe(arm.digest);
    const wrongArch = fakeRegistry({ repository: "library/postgres", images: [amd], tags: { "18": { bytes: amd.manifestBytes, type: MANIFEST_TYPE } } });
    expect(await resolverFor(wrongArch)(postgres)).toBeUndefined();
  });

  it("says nothing when the index has no linux/arm64 image, has two different ones, or only an attestation for it", async () => {
    const other = makeImage({ arch: "arm64", salt: "other" });
    const cases = [
      makeIndex([{ image: amd, os: "linux", architecture: "amd64" }]),
      makeIndex([{ image: arm, os: "linux", architecture: "arm64" }, { image: other, os: "linux", architecture: "arm64" }]),
      makeIndex([{ image: arm, os: "linux", architecture: "arm64", attestation: true }]),
      makeIndex([{ image: arm, os: "linux", architecture: "arm64", variant: "v7" }]),
    ];
    for (const index of cases) {
      const reg = fakeRegistry({ repository: "library/postgres", images: [arm, amd, other], tags: { "18": { bytes: index.bytes, type: "application/vnd.oci.image.index.v1+json" } } });
      expect(await resolverFor(reg)(postgres)).toBeUndefined();
    }
  });

  it("refuses a registry's own digest header that disagrees with the bytes, and a manifest that is not an image or an index", async () => {
    // The registry serves the right manifest and the right config, but names another digest for the manifest: that is a registry that disagrees with its own bytes.
    const lying = { fetchImpl: async (url: string) => (url.includes("/blobs/") ? reply(200, {}, arm.config) : reply(200, { "content-type": MANIFEST_TYPE, "docker-content-digest": `sha256:${hex("something else")}` }, arm.manifestBytes)) };
    const honest = { fetchImpl: async (url: string) => (url.includes("/blobs/") ? reply(200, {}, arm.config) : reply(200, { "content-type": MANIFEST_TYPE, "docker-content-digest": `sha256:${arm.digest}` }, arm.manifestBytes)) };
    expect(await registryDigestResolver(honest.fetchImpl, fakeLookup(PUBLIC_HOSTS).lookup)(postgres)).toBe(arm.digest);
    expect(await registryDigestResolver(lying.fetchImpl, fakeLookup(PUBLIC_HOSTS).lookup)(postgres)).toBeUndefined();
    const junk = { fetchImpl: async () => reply(200, { "content-type": "text/html" }, text("<html></html>")) };
    expect(await registryDigestResolver(junk.fetchImpl, fakeLookup(PUBLIC_HOSTS).lookup)(postgres)).toBeUndefined();
  });

  it("asks only an allowed registry: another registry, an IP literal and a look-alike get no request at all, and an extra registry only when the company listed it", async () => {
    const reg = fakeRegistry({ repository: "library/postgres", images: [arm], tags: { "18": { bytes: arm.manifestBytes, type: MANIFEST_TYPE } } });
    const resolve = resolverFor(reg, { ...PUBLIC_HOSTS, "evil.example.com": ["54.9.9.9"], "ghcr.io.evil.example.com": ["54.9.9.9"] });
    for (const registry of ["evil.example.com", "ghcr.io.evil.example.com", "169.254.169.254", "10.0.0.5", "registry.example.com"]) expect(await resolve({ ...postgres, registry }), registry).toBeUndefined();
    expect(reg.requests).toEqual([]);
    const own = fakeRegistry({ host: { apiHost: "registry.example.com" }, repository: "acme/postgres", images: [arm], tags: { "18": { bytes: arm.manifestBytes, type: MANIFEST_TYPE } } });
    const ownResolve = registryDigestResolver(own.fetchImpl, fakeLookup(PUBLIC_HOSTS).lookup);
    const image = { registry: "registry.example.com", repository: "acme/postgres", tag: "18" };
    expect(await ownResolve(image)).toBeUndefined();
    expect(own.requests).toEqual([]);
    expect(await ownResolve(image, ["registry.example.com"])).toBe(arm.digest);
    // The manifest and the config (to read the platform), both at the company's own registry host and nowhere else.
    expect(own.requests.map((request) => new URL(request.url).host)).toEqual(["registry.example.com", "registry.example.com"]);
  });

  it("says nothing for any failure: an error status, a thrown fetch, a name that resolves privately, and never throws", async () => {
    for (const fetchImpl of [async () => reply(500), async () => reply(404), async (): Promise<never> => { throw new Error("socket closed with a secret in it"); }]) {
      expect(await registryDigestResolver(fetchImpl, fakeLookup(PUBLIC_HOSTS).lookup)(postgres)).toBeUndefined();
    }
    const reg = fakeRegistry({ repository: "library/postgres", images: [arm], tags: { "18": { bytes: arm.manifestBytes, type: MANIFEST_TYPE } } });
    expect(await resolverFor(reg, { ...PUBLIC_HOSTS, "registry-1.docker.io": ["127.0.0.1"] })(postgres)).toBeUndefined();
    expect(reg.requests).toEqual([]);
  });
});

describe("a layer streams for as long as bytes keep arriving", () => {
  const image = makeImage();
  const layer = `sha256:${hex(image.layers[0]!)}`;
  const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  afterEach(() => { vi.useRealTimers(); });
  /** Like a real fetch body, the fake stops when the request's signal is aborted (a timer that is left running ends the download). */
  const nap = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
  /** A registry whose blob body comes in `chunks` pieces, `every` ms apart (then optionally stops for good). */
  const slowRegistry = (chunks: number, every: number, stall = false) => {
    const reg = fakeRegistry({ repository: "library/postgres", images: [image] });
    const base = reg.fetchImpl;
    reg.fetchImpl = async (url, init) => {
      if (!url.includes("/blobs/")) return base(url, init);
      return {
        status: 200, headers: { get: () => null },
        body: (async function* () {
          for (let index = 0; index < chunks; index += 1) { await nap(every, init.signal); yield new TextEncoder().encode(`part${String(index)};`); }
          if (stall) await new Promise<never>(() => undefined);
        })(),
      };
    };
    return createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres", fetchImpl: reg.fetchImpl, lookup: fakeLookup(PUBLIC_HOSTS).lookup });
  };
  const readAll = async (iterable: AsyncIterable<Uint8Array>): Promise<string> => { const parts: Uint8Array[] = []; for await (const part of iterable) parts.push(part); return Buffer.concat(parts).toString(); };

  it("completes a download that takes 30 seconds in 5-second steps, though a reply's headers and a manifest get 8 seconds", async () => {
    vi.useFakeTimers();
    const reading = readAll(slowRegistry(6, 5_000).blob(layer, 1_000));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await reading).toBe("part0;part1;part2;part3;part4;part5;");
  });

  it("ends a stalled download after the idle time with the fixed word `timeout`, and not before", async () => {
    vi.useFakeTimers();
    const result = readAll(slowRegistry(2, 5_000, true).blob(layer, 1_000)).then(() => "finished", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000 + 29_000);
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ reason: "timeout" });
  });

  it("gives a reply 8 seconds to start: a registry that never answers is `unavailable`", async () => {
    vi.useFakeTimers();
    const never = createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres", fetchImpl: () => new Promise(() => undefined), lookup: fakeLookup(PUBLIC_HOSTS).lookup });
    const result = never.manifest("18").then(() => "answered", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await result).toMatchObject({ reason: "unavailable" });
    const slowHeaders = createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres", fetchImpl: async () => { await sleep(9_000); return reply(200); }, lookup: fakeLookup(PUBLIC_HOSTS).lookup });
    const blob = readAll(slowHeaders.blob(layer, 1_000)).then(() => "answered", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await blob).toMatchObject({ reason: "unavailable" });
  });
});

describe("a company's own registry sends its blobs through a redirect (decision 93)", () => {
  const image = makeImage();
  const layer = `sha256:${hex(image.layers[0]!)}`;
  const own = (blobHost: string | undefined, table: Record<string, string[]>, target: string | undefined) => {
    const reg = fakeRegistry({ host: { apiHost: "registry.example.com", ...(blobHost === undefined ? {} : { blobHost }) }, repository: "acme/postgres", images: [image], auth: true, realm: "https://registry.example.com/token", ...(target === undefined ? {} : { blobRedirectTo: target }) });
    return { reg, client: createRegistryClient({ registry: "registry.example.com", extra: ["registry.example.com"], repository: "acme/postgres", fetchImpl: reg.fetchImpl, lookup: fakeLookup({ ...PUBLIC_HOSTS, ...table }).lookup }) };
  };
  const read = async (iterable: AsyncIterable<Uint8Array>) => { const parts: Uint8Array[] = []; for await (const part of iterable) parts.push(part); return Buffer.concat(parts).toString(); };

  it("follows a redirect to a public https host, whatever its name, and sends no Authorization header to it", async () => {
    for (const host of ["storage.googleapis.com", "my-bucket.s3.us-west-2.amazonaws.com", "cdn.some-customer.net"]) {
      const { reg, client } = own(host, { [host]: ["54.5.5.5"] }, `https://${host}`);
      expect(await read(client.blob(layer, 1_000)), host).toBe("layer one bytes");
      const hop = reg.requests.find((request) => new URL(request.url).host === host);
      expect(hop?.authorization, host).toBe(false);
      // The registry's own request carried the token it asked for; the redirected one never did.
      expect(reg.requests.filter((request) => new URL(request.url).host === "registry.example.com" && request.url.includes("/blobs/")).some((request) => request.authorization)).toBe(true);
    }
  });

  it("refuses a redirect to a private, loopback, link-local, metadata, IP-literal, http or odd-port host, or a name that does not resolve", async () => {
    const cases: Array<[string, string, Record<string, string[]>]> = [
      ["a private name", "https://internal-bucket.example.net", { "internal-bucket.example.net": ["10.0.0.9"] }],
      ["a loopback name", "https://loop.example.net", { "loop.example.net": ["127.0.0.1"] }],
      ["a metadata name", "https://meta.example.net", { "meta.example.net": ["169.254.169.254"] }],
      ["a name with a private answer among public ones", "https://mixed.example.net", { "mixed.example.net": ["54.5.5.5", "192.168.1.5"] }],
      ["the metadata address", "https://169.254.169.254", {}],
      ["a decimal IP literal", "https://2130706433", {}],
      ["an IPv6 literal", "https://[::1]", {}],
      ["http", "http://cdn.example.net", { "cdn.example.net": ["54.5.5.5"] }],
      ["an odd port", "https://cdn.example.net:8443", { "cdn.example.net": ["54.5.5.5"] }],
      ["credentials in the address", "https://user:pw@cdn.example.net", { "cdn.example.net": ["54.5.5.5"] }],
      ["a name that does not resolve", "https://nowhere.example.net", {}],
    ];
    for (const [label, target, table] of cases) {
      const { reg, client } = own(undefined, table, target);
      await expect(read(client.blob(layer, 1_000)), label).rejects.toBeInstanceOf(RegistryClientError);
      const reached = reg.requests.map((request) => request.url).filter((url) => !url.startsWith("https://registry.example.com/"));
      expect(reached, label).toEqual([]);
    }
  });

  it("holds the bytes to their digest wherever they came from: a redirect target that serves other bytes is refused by the copy", async () => {
    const { reg, client } = own("cdn.some-customer.net", { "cdn.some-customer.net": ["54.5.5.5"] }, "https://cdn.some-customer.net");
    reg.blobs.set(layer, new TextEncoder().encode("bytes from somewhere else"));
    const { copyApprovedImage } = await import("../../packages/broker/src/test-env/company-image-mirror.js");
    const completed: string[] = [];
    const result = await copyApprovedImage({
      registry: () => client, now: () => 0, deadlineMs: 1e12,
      ecr: { available: async () => new Set(), uploadBlob: async (digest, parts) => { for await (const part of parts) void part; completed.push(digest); }, putImage: async () => undefined, readBack: async () => image.digest },
    }, { registry: "registry.example.com", extraRegistries: ["registry.example.com"], digest: image.digest, repository: "acme/postgres" });
    expect(result).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(completed).not.toContain(layer);
  });

  it("follows at most three redirects for a blob, and refuses the fourth, for a company's own registry and for a built-in one", async () => {
    const hosts = ["h1.example.net", "h2.example.net", "h3.example.net", "h4.example.net", "h5.example.net"];
    const table = Object.fromEntries(hosts.map((host) => [host, ["54.5.5.5"]]));
    /** The registry sends the blob through `hops` redirects, one host after another, and the last host serves it. */
    const chain = (registry: string, apiHost: string, redirects: number) => {
      const seen: string[] = [];
      const fetchImpl: Parameters<typeof createRegistryClient>[0]["fetchImpl"] = async (url) => {
        const host = new URL(url).host;
        seen.push(host);
        const step = host === apiHost ? 0 : hosts.indexOf(host) + 1;
        if (step < redirects) return reply(307, { location: `https://${hosts[step]}/blob` });
        return reply(200, {}, image.layers[0]);
      };
      const client = createRegistryClient({ registry, extra: ["registry.example.com"], repository: registry === "docker.io" ? "library/postgres" : "acme/postgres", fetchImpl, lookup: fakeLookup({ ...PUBLIC_HOSTS, ...table }).lookup });
      return { client, seen };
    };
    for (const [registry, apiHost] of [["registry.example.com", "registry.example.com"]] as const) {
      const three = chain(registry, apiHost, 3);
      expect(await read(three.client.blob(layer, 1_000))).toBe("layer one bytes");
      expect(three.seen).toEqual([apiHost, "h1.example.net", "h2.example.net", "h3.example.net"]);
      const four = chain(registry, apiHost, 4);
      await expect(read(four.client.blob(layer, 1_000))).rejects.toMatchObject({ reason: "unavailable" });
      // The fourth redirect is not followed: the fifth host is never asked.
      expect(four.seen).toEqual([apiHost, "h1.example.net", "h2.example.net", "h3.example.net"]);
      const many = chain(registry, apiHost, 5);
      await expect(read(many.client.blob(layer, 1_000))).rejects.toMatchObject({ reason: "unavailable" });
      expect(many.seen).not.toContain("h5.example.net");
    }
    // A built-in registry: its blob hosts are listed ones (a `.docker.com` name), and the same cap holds.
    const builtIn = (redirects: number) => {
      const seen: string[] = [];
      const names = ["a.docker.com", "b.docker.com", "c.docker.com", "d.docker.com", "e.docker.com"];
      const fetchImpl: Parameters<typeof createRegistryClient>[0]["fetchImpl"] = async (url) => {
        const host = new URL(url).host;
        seen.push(host);
        const step = host === "registry-1.docker.io" ? 0 : names.indexOf(host) + 1;
        return step < redirects ? reply(307, { location: `https://${names[step]}/blob` }) : reply(200, {}, image.layers[0]);
      };
      return { seen, client: createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres", fetchImpl, lookup: fakeLookup({ ...PUBLIC_HOSTS, ...Object.fromEntries(names.map((name) => [name, ["54.5.5.5"]])) }).lookup }) };
    };
    expect(await read(builtIn(3).client.blob(layer, 1_000))).toBe("layer one bytes");
    const refused = builtIn(4);
    await expect(read(refused.client.blob(layer, 1_000))).rejects.toMatchObject({ reason: "unavailable" });
    expect(refused.seen).toEqual(["registry-1.docker.io", "a.docker.com", "b.docker.com", "c.docker.com"]);
  });

  it("keeps the built-in registries to their listed blob hosts", async () => {
    const reg = fakeRegistry({ repository: "library/postgres", images: [image], blobRedirectTo: "https://storage.googleapis.com" });
    const client = createRegistryClient({ registry: "docker.io", extra: [], repository: "library/postgres", fetchImpl: reg.fetchImpl, lookup: fakeLookup({ ...PUBLIC_HOSTS, "storage.googleapis.com": ["54.5.5.5"] }).lookup });
    await expect(read(client.blob(layer, 1_000))).rejects.toMatchObject({ reason: "not_allowed" });
  });
});
