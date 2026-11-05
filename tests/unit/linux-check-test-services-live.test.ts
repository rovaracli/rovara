// Test services slice 1, T4: the live Linux checks' driver (scripts/linux-check-test-services-live.ts), run against fakes. Nothing here starts Docker. The probe program is run for real against a local server.
import { execFile, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BlockedError, ITEMS, LISTEN_JS, embeddedResolverLines, PROBE_JS, RELAY_LISTENER_JS, SSM_CHUNK_CHARS, TSL_WORKSPACE, blockedLines, formatLine, hasDefaultRoute, labelArgsFrom, loadVerifiedCatalog, manifestFilesPort, parseProbeOutput, parseUids, postgresEntry, pullList, resolvePostgres, runLiveChecks, ssmCommands, unexpected,
  type EmbeddedResolverEvidence, type RunLayer,
} from "../../scripts/linux-check-test-services-live.js";
import { CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, type VerifiedCatalog } from "@agentx/contracts";
import { loadSignedCatalogWithKeys } from "@agentx/contracts/testing";
import { pinnedCatalog, sha, testSigner } from "../support/catalog-pinning.js";

const REGISTRY = "944937319445.dkr.ecr.us-west-2.amazonaws.com";
const IMAGE = `${REGISTRY}/agentx-staging/worker@sha256:${"a".repeat(64)}`;

describe("the live driver's lines and probe output", () => {
  it("the relay listener survives a peer that connects and resets before reading (it used to die on ECONNRESET, so the working sandbox exited)", async () => {
    const program = RELAY_LISTENER_JS.replace("listen(7777,", "listen(0,").replace("setInterval(()=>{},1e6)", "");
    expect(RELAY_LISTENER_JS).toContain("s.on('error',()=>{})");
    const script = `const http=require('net');const srv=(()=>{${program.replace("require('net').createServer", "return require('net').createServer")}})();srv.on('listening',async()=>{const port=srv.address().port;
      for(let i=0;i<20;i+=1){await new Promise((done)=>{const c=http.connect(port,'127.0.0.1',()=>{setTimeout(()=>{c.resetAndDestroy();done();},20);});c.on('error',done);});}
      await new Promise((r)=>setTimeout(r,200));console.log('alive');process.exit(0);});`;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe("alive");
  });

  it("formats a line the way the shell script counts it, on one line, with the removed values gone", () => {
    expect(formatLine({ id: "L1.live", status: "PASS", name: "x", detail: "ok" })).toBe("TSL L1.live PASS x | ok");
    const line = formatLine({ id: "L4.live", status: "FAIL", name: "y", detail: `bad\nsecret=hunter2hunter2 and ${"z".repeat(500)}` }, (text) => text.split("hunter2hunter2").join("[removed]"));
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("\n");
    expect(line.split(" | ")[1]!.length).toBeLessThanOrEqual(400);
  });
  it("parses probe lines by label, ignores noise and keeps the first of a repeated label", () => {
    const results = parseProbeOutput("a open\nb timeout\nc error:ECONNRESET\nd resolved 172.30.5.16\nnoise here\ne answer rcode=3 an=0\na refused\nroutes routes v4=\n");
    expect(results.get("a")).toEqual({ status: "open", rest: "" });
    expect(results.get("d")).toEqual({ status: "resolved", rest: "172.30.5.16" });
    expect(results.get("c")?.status).toBe("error:ECONNRESET");
    expect(results.has("noise")).toBe(false);
  });
  it("judges: a missing line is a problem, and so is a status that is not allowed", () => {
    const results = parseProbeOutput("a timeout\nb open\n");
    expect(unexpected(results, ["a"], ["timeout"])).toEqual([]);
    expect(unexpected(results, ["a", "b", "c"], ["timeout"])).toEqual(["b=open", "c=no-result"]);
  });
  it("finds a default route in the kernel's table (destination 00000000) and not a /24 alone", () => {
    expect(hasDefaultRoute("v4=eth0:0000FEAC:00000000:0001 v6routes=0")).toBe(false);
    expect(hasDefaultRoute("v4=eth0:00000000:0100FEAC:0003,eth0:0000FEAC:00000000:0001 v6routes=0")).toBe(true);
    expect(hasDefaultRoute("v4= v6routes=0")).toBe(false);
  });
  it("copies only the run-network labels of a container, and only plain values", () => {
    const labels = JSON.stringify({ "rovara.run-network": "rovara-svc-0123456789ab", "rovara.run-network.expires": "17", "rovara.run-network.workspace": TSL_WORKSPACE, "other": "x", "rovara.run-network.evil": "a b;rm", "com.docker": "1" });
    expect(labelArgsFrom(labels)).toEqual(["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.expires=17", "--label", `rovara.run-network.workspace=${TSL_WORKSPACE}`]);
    expect(labelArgsFrom("not json")).toEqual([]);
    expect(labelArgsFrom("[]")).toEqual([]);
  });
});

describe("the probe program, run for real against a local server", () => {
  let server: Server;
  const run = async (tests: unknown[]) => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((done) => closed.close(() => done()));
    const config = JSON.stringify({ tests: (tests as Array<Record<string, unknown>>).map((test) => ({ ...test, port: test["label"] === "closed" ? closedPort : test["port"] ?? port })) });
    const ran = await new Promise<string>((resolve) => {
      const child = spawnSync(process.execPath, ["-e", PROBE_JS, config], { encoding: "utf8", timeout: 20_000 });
      resolve(child.stdout);
    });
    await new Promise<void>((done) => server.close(() => done()));
    return parseProbeOutput(ran);
  };
  it("says open for a server that accepts, refused for a closed port, and reads and refuses writes to files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsl-probe-"));
    try {
      const results = await run([
        { label: "open", kind: "conn", host: "127.0.0.1", ms: 3000 }, { label: "closed", kind: "conn", host: "127.0.0.1", ms: 3000 },
        { label: "file", kind: "file", path: "/etc/hosts" }, { label: "gone", kind: "file", path: join(dir, "missing") }, { label: "denied", kind: "write", path: join(dir, "no/such/dir/file") },
        { label: "addrs", kind: "addrs" }, { label: "routes", kind: "routes" }, { label: "look", kind: "lookup", name: "localhost" },
      ]);
      expect(results.get("open")?.status).toBe("open");
      expect(results.get("closed")?.status).toBe("refused");
      expect(results.get("file")?.status).toBe("file");
      expect(results.get("gone")?.status).toMatch(/^error:/u);
      expect(results.get("denied")?.status).toBe("denied");
      expect(results.get("addrs")?.status).toBe("addrs");
      expect(results.get("routes")?.status).toBe("routes");
      expect(results.get("look")?.status).toBe("resolved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
  it("has a listener program that reports silence when nothing is sent", () => {
    const ran = spawnSync(process.execPath, ["-e", LISTEN_JS, JSON.stringify({ port: 45353, groups: [], ms: 300 })], { encoding: "utf8", timeout: 10_000 });
    expect(ran.stdout.trim()).toBe("silent");
  });
});

describe("the probe program's resolver probes (TS-SEAL-5)", () => {
  const runProbe = (tests: unknown[]) => parseProbeOutput(spawnSync(process.execPath, ["-e", PROBE_JS, JSON.stringify({ tests })], { encoding: "utf8", timeout: 20_000 }).stdout);

  it("sends a DNS query to a port other than 53 when it is given one, and reads the answer's code and record count", async () => {
    const server = createSocket("udp4");
    const seen: number[] = [];
    server.on("message", (message, remote) => {
      seen.push(remote.port);
      const reply = Buffer.alloc(12);
      message.copy(reply, 0, 0, 2);
      reply.writeUInt16BE(0x8180, 2);
      reply.writeUInt16BE(1, 6);
      server.send(reply, remote.port, remote.address);
    });
    await new Promise<void>((done) => server.bind(0, "127.0.0.1", done));
    const port = server.address().port;
    try {
      // asynchronous, so this process's event loop can answer the probe (spawnSync would block the server)
      const out = await new Promise<string>((done) => { execFile(process.execPath, ["-e", PROBE_JS, JSON.stringify({ tests: [{ label: "q", kind: "dnsq", server: "127.0.0.1", name: "postgres", port }] })], { timeout: 20_000 }, (_error, stdout) => { done(stdout); }); });
      const results = parseProbeOutput(out);
      expect(results.get("q")).toEqual({ status: "answer", rest: "rcode=0 an=1" });
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it("embdirect says error:NOLISTENER where nothing listens on 127.0.0.11 (so a missing resolver socket can never read as a silent, closed one), and caps reads the capability masks or a read error", () => {
    const results = runProbe([{ label: "d", kind: "embdirect", name: "postgres", ms: 500 }, { label: "t", kind: "embdirecttcp", ms: 500 }, { label: "c", kind: "caps" }, { label: "v", kind: "v6listen" }]);
    expect(results.get("d")?.status).toBe("error:NOLISTENER");
    expect(results.get("t")?.status).toBe("error:NOLISTENER");
    // no IPv6 listener but loopback or wildcard ones, where a test machine has any (a machine without /proc/net/tcp6 has none)
    expect(results.get("v")?.status).toBe("v6listen");
    expect(results.get("v")?.rest).toMatch(/^bad=/u);
    const caps = results.get("c");
    if (caps?.status === "caps") expect(caps.rest).toMatch(/^eff=[0-9a-f]+ bnd=[0-9a-f]+ amb=[0-9a-f]+$/iu);
    else expect(caps?.status).toMatch(/^error:/u);
  }, 30_000);
});

describe("the two embedded-resolver items (TS-SEAL-5)", () => {
  const rows = (text: string) => parseProbeOutput(text);
  const sealed = "resolv file \"nameserver 172.30.5.2\"\nembedded error:EPERM\nembedded-public error:EPERM\nembedded-tcp timeout\nembedded-direct error:EPERM\nembedded-direct-tcp timeout\nv6 v6listen bad=\ncaps caps eff=0000000000000000 bnd=0000000000000000 amb=0000000000000000\n";
  const control = "ctl-embedded answer rcode=0 an=1\nctl-embedded-tcp open\nctl-embedded-direct answer rcode=0 an=1\nctl-embedded-direct-tcp open\nctl-embedded-public answer rcode=0 an=0\n";
  const rules = "-P OUTPUT ACCEPT\n-A OUTPUT -d 127.0.0.11/32 -j DROP\n";
  const evidence = (change: Partial<EmbeddedResolverEvidence> = {}, sealedText = sealed, controlText = control): EmbeddedResolverEvidence => ({
    results: rows(sealedText), control: rows(controlText), nameservers: ["172.30.5.2"], dnsHelperIp: "172.30.5.2", resolvChanged: false, guardContainerGone: true, outputRules: rules, ...change,
  });
  const byId = (input: EmbeddedResolverEvidence) => Object.fromEntries(embeddedResolverLines(input).map((line) => [line.id, line]));
  const blocked = (input: EmbeddedResolverEvidence) => byId(input)["L3.embedded-resolver-blocked"]!;

  it("pass when the guard has closed 127.0.0.11 on every path, the rule is first in the chain, and an unguarded container still gets an answer on each", () => {
    const lines = byId(evidence());
    expect(lines["L3.embedded-resolver"]).toMatchObject({ status: "PASS" });
    expect(lines["L3.embedded-resolver-blocked"]).toMatchObject({ status: "PASS", name: "embedded-resolver-closed-in-the-sealed-sandbox" });
    expect(embeddedResolverLines(evidence()).map((line) => line.id)).toEqual(["L3.embedded-resolver", "L3.embedded-resolver-blocked"]);
  });

  it("L3.embedded-resolver measures the accepted floor where the resolver is OPEN (the unguarded control): a public name gets no address there, and the run's own container names may be answered", () => {
    expect(byId(evidence())["L3.embedded-resolver"]!.detail).toContain("answer");
    for (const good of ["ctl-embedded-public answer rcode=0 an=0", "ctl-embedded-public timeout", "ctl-embedded-public answer rcode=3 an=0", "ctl-embedded-public error:EHOSTUNREACH"]) {
      expect(byId(evidence({}, sealed, control.replace("ctl-embedded-public answer rcode=0 an=0", good)))["L3.embedded-resolver"]!.status, good).toBe("PASS");
    }
    for (const bad of ["ctl-embedded-public answer rcode=0 an=1", "ctl-embedded-public answer rcode=0 an=2", "ctl-embedded-public open", "ctl-embedded-public resolved 1.2.3.4"]) {
      const line = byId(evidence({}, sealed, control.replace("ctl-embedded-public answer rcode=0 an=0", bad)))["L3.embedded-resolver"]!;
      expect(line.status, bad).toBe("FAIL");
      expect(line.detail, bad).toContain("embedded-public-in-the-unguarded-control=");
    }
    expect(byId(evidence({}, sealed, control.replace("ctl-embedded-public answer rcode=0 an=0\n", "")))["L3.embedded-resolver"]!.detail).toContain("embedded-public-in-the-unguarded-control=no-result");
  });

  it("L3.embedded-resolver does not take the sealed sandbox's own public-name probe as the measurement (it is only ever the guard's EPERM)", () => {
    expect(byId(evidence({}, sealed.replace("embedded-public error:EPERM", "embedded-public answer rcode=0 an=1")))["L3.embedded-resolver"]!.status).toBe("PASS");
    // ...but the guard item does fail on it
    expect(blocked(evidence({}, sealed.replace("embedded-public error:EPERM", "embedded-public answer rcode=0 an=1"))).status).toBe("FAIL");
  });

  it("L3.embedded-resolver still needs resolv.conf to name the DNS helper alone and to be unchanged", () => {
    expect(byId(evidence({ nameservers: ["172.30.5.2", "8.8.8.8"] }))["L3.embedded-resolver"]).toMatchObject({ status: "FAIL" });
    expect(byId(evidence({ nameservers: [] }))["L3.embedded-resolver"]!.detail).toContain("resolv.conf-names:none");
    expect(byId(evidence({ resolvChanged: true }))["L3.embedded-resolver"]!.detail).toContain("resolv.conf-changed");
  });

  it("the guard item fails when any path still gets through: the answer on port 53, the TCP connections, the resolver's own UDP port, a public name", () => {
    for (const [from, to, label] of [
      ["embedded error:EPERM", "embedded answer rcode=0 an=1", "embedded=answer"], ["embedded-public error:EPERM", "embedded-public answer rcode=0 an=0", "embedded-public=answer"],
      ["embedded-tcp timeout", "embedded-tcp open", "embedded-tcp=open"], ["embedded-direct error:EPERM", "embedded-direct answer rcode=0 an=1", "embedded-direct=answer"],
      ["embedded-direct-tcp timeout", "embedded-direct-tcp open", "embedded-direct-tcp=open"],
    ] as const) {
      const line = blocked(evidence({}, sealed.replace(from, to)));
      expect(line.status, label).toBe("FAIL");
      expect(line.detail, label).toContain(label);
    }
  });

  it("the UDP probes must show EPERM, the rule's own refusal: a timeout is not enough (something else dropped the packet), TCP may time out or be refused", () => {
    for (const label of ["embedded", "embedded-public", "embedded-direct"]) {
      const line = blocked(evidence({}, sealed.replace(`${label} error:EPERM`, `${label} timeout`)));
      expect(line.status, label).toBe("FAIL");
      expect(line.detail, label).toContain(`${label}=timeout`);
    }
    expect(blocked(evidence({}, sealed.replace("embedded-tcp timeout", "embedded-tcp error:EPERM"))).status).toBe("PASS");
    expect(blocked(evidence({}, sealed.replace("embedded-tcp timeout", "embedded-tcp refused"))).status).toBe("PASS");
  });

  it("the guard item needs its positive control: with no resolver answering the unguarded container, a silent sandbox proves nothing", () => {
    for (const [change, label] of [
      ["ctl-embedded answer rcode=0 an=1\n", "ctl-embedded=no-result"], ["ctl-embedded-tcp open\n", "ctl-embedded-tcp=no-result"], ["ctl-embedded-direct answer rcode=0 an=1\n", "ctl-embedded-direct=no-result"],
      ["ctl-embedded-direct-tcp open\n", "ctl-embedded-direct-tcp=no-result"],
    ] as const) {
      const line = blocked(evidence({}, sealed, control.replace(change, "")));
      expect(line.status, label).toBe("FAIL");
      expect(line.detail, label).toContain(`control-failed:${label}`);
    }
    expect(blocked(evidence({}, sealed, control.replace("ctl-embedded-tcp open", "ctl-embedded-tcp timeout"))).detail).toContain("control-failed:ctl-embedded-tcp=timeout");
  });

  it("the guard item fails when a direct probe found no resolver socket to ask (it would read as silence), when the sandbox has a capability, and when the guard container is left", () => {
    expect(blocked(evidence({}, sealed.replace("embedded-direct error:EPERM", "embedded-direct error:NOLISTENER"))).detail).toContain("embedded-direct-found-no-resolver-socket");
    expect(blocked(evidence({}, sealed.replace("embedded-direct-tcp timeout", "embedded-direct-tcp error:NOLISTENER"))).detail).toContain("embedded-direct-tcp-found-no-resolver-socket");
    expect(blocked(evidence({}, sealed.replace("eff=0000000000000000", "eff=0000000000001000"))).detail).toContain("sandbox-has-capabilities");
    expect(blocked(evidence({}, sealed.replace(/caps caps .*\n/u, ""))).detail).toContain("sandbox-has-capabilities:no-result");
    expect(blocked(evidence({ guardContainerGone: false })).detail).toContain("guard-container-left-behind-or-unreadable");
  });

  it("the guard item reads the rule back from outside: it must be the first rule of the OUTPUT chain; another first rule, a missing rule or an unreadable list fails", () => {
    for (const [text, why] of [
      ["-P OUTPUT ACCEPT\n-A OUTPUT -d 10.0.0.1/32 -j ACCEPT\n-A OUTPUT -d 127.0.0.11/32 -j DROP\n", "second"], ["-P OUTPUT ACCEPT\n", "missing"], ["", "empty"],
      ["-P OUTPUT ACCEPT\n-A OUTPUT -d 127.0.0.11/32 -j ACCEPT\n", "wrong target"], ["-P OUTPUT ACCEPT\n-A OUTPUT -d 127.0.0.11/32 -p udp -j DROP\n", "only udp"],
    ] as const) {
      const line = blocked(evidence({ outputRules: text }));
      expect(line.status, why).toBe("FAIL");
      expect(line.detail, why).toContain("rule-not-first-in-the-chain");
    }
    const unreadable = blocked(evidence({ outputRules: undefined }));
    expect(unreadable.status).toBe("FAIL");
    expect(unreadable.detail).toContain("rule-not-first-in-the-chain:unreadable");
  });

  it("the guard item fails on an IPv6 listener that is not the loopback or the wildcard, and on a v6 probe that did not run", () => {
    expect(blocked(evidence({}, sealed.replace("v6 v6listen bad=", "v6 v6listen bad=tcp6:0000000000000000FFFF00000B00007F:1F90"))).detail).toContain("ipv6-listener:v6listen(bad=tcp6:");
    expect(blocked(evidence({}, sealed.replace("v6 v6listen bad=\n", ""))).detail).toContain("ipv6-listener:no-result");
    expect(blocked(evidence({}, sealed.replace("v6 v6listen bad=", "v6 error:EACCES"))).status).toBe("FAIL");
  });
});

// A catalog whose postgres@16 digest is the SHA-256 of a manifest we hold, signed by a test-only key made now.
const MANIFEST = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [] }));
const MANIFEST_DIGEST = sha256HexOf(MANIFEST);
async function signedCatalog(change: (entries: Array<Record<string, unknown>>) => void = () => undefined) {
  const signer = testSigner();
  const catalogBytes = Buffer.from(JSON.stringify(pinnedCatalog((entries) => { (entries.find((entry) => entry["id"] === "postgres@16")!["image"] as { digest: string }).digest = MANIFEST_DIGEST; change(entries); }), null, 2), "utf8");
  const signature = (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
  return { catalogBytes, signatureBytes, keys: [signer.publicKeyPem] };
}
const verifiedFrom = (files: Awaited<ReturnType<typeof signedCatalog>>): VerifiedCatalog => {
  const loaded = loadSignedCatalogWithKeys({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, trustedKeys: files.keys });
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.catalog;
};
const verified = async (): Promise<VerifiedCatalog> => verifiedFrom(await signedCatalog());
const served = manifestFilesPort(async (digest) => (digest === MANIFEST_DIGEST ? MANIFEST : undefined));

describe("the catalog the checks need", () => {
  it("is loaded through loadSignedCatalog: with no compiled-in key it is BLOCKED (not a pass), with no signature file it says so, and an untrusted signature is refused", async () => {
    const files = await signedCatalog();
    expect(() => loadVerifiedCatalog({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, runningAccountId: "944937319445" })).toThrow(BlockedError);
    expect(() => loadVerifiedCatalog({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, runningAccountId: "944937319445" })).toThrow("BLOCKED: no trusted catalog key");
    expect(() => loadVerifiedCatalog({ catalogBytes: files.catalogBytes, signatureBytes: Buffer.alloc(0), runningAccountId: undefined })).toThrow(/no signature file/u);
    // the driver has no way to be handed a key: a key passed anyway is not used
    expect(() => (loadVerifiedCatalog as (input: unknown) => unknown)({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, runningAccountId: "944937319445", trustedKeys: files.keys })).toThrow(BlockedError);
    expect(await verified()).toBeDefined();
  });
  it("reports every live item as a FAIL with the BLOCKED reason, and none as a pass", () => {
    const lines = blockedLines("BLOCKED: no trusted catalog key");
    expect(lines.map((line) => line.id)).toEqual(["L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.embedded-resolver-blocked", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live"]);
    expect(lines.every((line) => line.status === "FAIL" && line.detail === "BLOCKED: no trusted catalog key")).toBe(true);
  });
  it("refuses a catalog that pins everything but Postgres 16", async () => {
    const files = await signedCatalog((entries) => { const entry = entries.find((candidate) => candidate["id"] === "postgres@16")!; delete (entry["image"] as { digest?: string }).digest; delete entry["sbomRef"]; delete entry["scan"]; });
    expect(() => postgresEntry(verifiedFrom(files))).toThrow(/not pinned/u);
  });
  it("lists the one image to pull, by digest, from the environment's catalog repository, and never by tag", async () => {
    const list = pullList({ catalog: await verified(), registry: REGISTRY, env: "staging" });
    expect(list).toEqual([`${REGISTRY}/rovara-catalog/staging/svc/postgres@sha256:${MANIFEST_DIGEST}`]);
  });
  it("goes through resolveCatalogImage: the registry must serve the catalog's digest, by bytes hashed here", async () => {
    const catalog = await verified();
    await expect(resolvePostgres({ catalog, manifests: served, env: "staging" })).resolves.toBeUndefined();
    await expect(resolvePostgres({ catalog, manifests: manifestFilesPort(async () => undefined), env: "staging" })).rejects.toThrow(/registry|verified/u);
    await expect(resolvePostgres({ catalog, manifests: manifestFilesPort(async () => Buffer.from("other bytes")), env: "staging" })).rejects.toThrow(/registry|verified/u);
    // a catalog that was not returned by loadSignedCatalog is refused
    await expect(resolvePostgres({ catalog: JSON.parse(JSON.stringify(catalog)) as VerifiedCatalog, manifests: served, env: "staging" })).rejects.toThrow(/verified/u);
  });
  it("reads the manifest files by a 64-hex digest only", async () => {
    const port = manifestFilesPort(async () => MANIFEST);
    expect(await port.manifestBytes("r", "../../etc/passwd")).toBeUndefined();
    expect(await port.manifestBytes("r", MANIFEST_DIGEST)).toBeDefined();
    void sha;
  });
  it("reads the Uid line of /proc/1/status: root is any of the four ids being 0", () => {
    expect(parseUids("Name:\tpostgres\nUid:\t999\t999\t999\t999\nGid:\t999\t999\t999\t999\n")).toEqual([999, 999, 999, 999]);
    expect(parseUids("Uid:\t999\t0\t999\t999\n")?.includes(0)).toBe(true);
    expect(parseUids("Uid:\t0\t0\t0\t0")?.includes(0)).toBe(true);
    for (const bad of ["", "Uid: 999", "Name: x\n", "Uid:\tx\ty\tz\tw"]) expect(parseUids(bad), bad).toBeUndefined();
  });
});

describe("the whole run, with a launcher that fails", () => {
  const fakeLayer = (events: string[]): RunLayer => ({
    helpers: { sweepServicesNetworksAtWorkerStart: async () => { events.push("sweep"); return { containers: 0, networks: 0 }; } },
    env: {
      createRunDirectoryFiles: async (_parent: string, name: string) => ({ directory: `/nowhere/${name}`, write: async () => "/x", remove: async () => undefined }),
      removeRunDirectory: async (directory: string) => { events.push(`remove ${directory}`); },
    },
    reset: { createResetHooks: () => ({}) },
    runner: {
      createDockerServiceRunner: () => ({
        start: (input: { helpers: ReadonlyArray<{ credentials?: { password?: string } }> }) => Promise.reject(new Error(`could not start; env had ${input.helpers[0]?.credentials?.password ?? "?"}`)),
      }),
    },
    runNetwork: {}, check: {}, containers: { createDockerCli: () => ({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) },
  } as unknown as RunLayer);

  it("gives FAIL for every item of a check that cannot run, never a PASS, keeps the password out of every line, and cleans up and sweeps after each item", async () => {
    const events: string[] = [];
    const { lines, redact } = await runLiveChecks({ catalog: await verified(), manifests: served, registry: REGISTRY, env: "staging", workerImage: IMAGE, workDir: await mkdtemp(join(tmpdir(), "tsl-run-")), layer: fakeLayer(events) });
    expect(lines.map((line) => line.id)).toEqual([
      "L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.embedded-resolver-blocked", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live",
    ]);
    expect(lines.every((line) => line.status === "FAIL")).toBe(true);
    const printed = lines.map((line) => formatLine(line, redact)).join("\n");
    expect(printed).toContain("the check could not run");
    expect(printed).not.toMatch(/env had [A-Za-z0-9]{24}/u);
    expect(printed).toContain("[removed]");
    // one sweep before the first item and one after each of the five items
    expect(events.filter((event) => event === "sweep")).toHaveLength(1 + ITEMS.length);
    expect(events.filter((event) => event.startsWith("remove ")).length).toBeGreaterThan(0);
  });
  it("refuses to run at all when the registry does not serve the catalog's digest, before it starts anything", async () => {
    const events: string[] = [];
    await expect(runLiveChecks({ catalog: await verified(), manifests: manifestFilesPort(async () => undefined), registry: REGISTRY, env: "staging", workerImage: IMAGE, workDir: "/tmp", layer: fakeLayer(events) })).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

describe("delivery through SSM", () => {
  it("sends each file gzipped in short base64 pieces and runs the script with TSL_DIR, in a root-only directory it removes", () => {
    const files = { script: "#!/bin/bash\necho script\n".repeat(2000), driver: "export const x = 1;\n".repeat(3000), catalog: JSON.stringify({ a: 1 }), signature: JSON.stringify({ sig: 1 }) };
    const commands = ssmCommands(files);
    expect(commands[0]).toContain("umask 077");
    expect(commands.every((command) => command.length < SSM_CHUNK_CHARS + 200)).toBe(true);
    expect(commands.at(-1)).toBe('TSL_DIR="$d" bash "$d/s.sh"; rc=$?; rm -rf "$d"; exit $rc');
    for (const [name, text] of Object.entries({ "s.sh": files.script, "live.mjs": files.driver, "catalog.json": files.catalog, "catalog.sig.json": files.signature })) {
      const encoded = commands.filter((command) => command.includes(`>> "$d/${name}.b64"`)).map((command) => /printf '%s' '([^']*)'/u.exec(command)![1]!).join("");
      expect(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")).toBe(text);
    }
  });
});

describe("the driver file", () => {
  it("makes no AWS call and reads no secret store", async () => {
    const source = await readFile(new URL("../../scripts/linux-check-test-services-live.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/secretsmanager|get-secret-value|@aws-sdk|aws ecr|process\.env\[?"?(?:AWS_|OPENAI|ANTHROPIC)/u);
  });
});
