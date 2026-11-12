// Owner decision 123: what an entry of the company's internal address list may be. One rule (packages/cloud-contracts/src/app-private-addresses.ts) for the browser, the route, the launch and, for addresses, the worker.
import { describe, expect, it } from "vitest";
import {
  PRIVATE_ADDRESSES_BOOT_PATTERN, PRIVATE_ADDRESSES_MAX, PRIVATE_ADDRESS_REFUSALS, PrivateAddressesBodySchema, checkPrivateAddress, checkPrivateAddressList, ipv4Number, privateAddressListDigest, privateAddressRefusalText,
  type PrivateAddressInstall,
} from "@agentx/cloud-contracts";
import { AGENTX_PRODUCTION_VPC_CIDR } from "../../infra/lib/production-foundation.js";
import { INSTALL_VPC_CIDR_DEFAULT, privateAddressInstallOf } from "../../packages/broker/src/org/private-address-install.js";

const INSTALL: PrivateAddressInstall = { vpcCidrs: ["10.42.0.0/16"], serviceHosts: ["internal-rovara-proxy-123.us-east-1.elb.amazonaws.com", "api.rovara.example"] };
const refusal = (text: string) => { const checked = checkPrivateAddress(text, INSTALL); return checked.ok ? "ok" : checked.refusal; };

describe("an entry", () => {
  it("is one host and one port, a name or a plain IPv4 private address, kept in one lower-case form", () => {
    expect(checkPrivateAddress("Nexus.Corp.Example:8081", INSTALL)).toEqual({ ok: true, entry: "nexus.corp.example:8081", host: "nexus.corp.example", port: 8081, kind: "name" });
    expect(checkPrivateAddress(" 10.20.0.15:443 ", INSTALL)).toEqual({ ok: true, entry: "10.20.0.15:443", host: "10.20.0.15", port: 443, kind: "ip" });
    for (const ok of ["172.16.4.5:8081", "100.64.1.2:80", "artifactory.internal.example:443", "vpce-0abc-1234.codeartifact.us-east-1.vpce.amazonaws.com:443", "a-b.c:1", "x.y:65535"]) expect(refusal(ok), ok).toBe("ok");
  });

  it("refuses wildcards anywhere", () => {
    for (const text of ["*.corp.example:443", "nexus.corp.example:*", "*:443", "10.0.0.*:80"]) expect(refusal(text), text).toBe("wildcard");
  });

  it("refuses ranges of addresses (CIDR), and a URL or a path", () => {
    for (const text of ["10.0.0.0/8", "10.20.0.0/16:443", "10.20.0.15/32:443", "fd00::/8"]) expect(refusal(text), text).toBe("cidr");
    for (const text of ["https://nexus.corp.example:8081", "nexus.corp.example:8081/repository/npm", "user@nexus.corp.example:443", "nexus.corp.example:443?x=1"]) expect(refusal(text), text).toBe("scheme_or_path");
  });

  it("refuses an entry without a port, a port range and a port that is not one number from 1 to 65535", () => {
    for (const text of ["nexus.corp.example", "10.20.0.15", "nexus.corp.example:"]) expect(refusal(text), text).toBe("missing_port");
    for (const text of ["nexus.corp.example:0", "nexus.corp.example:65536", "nexus.corp.example:08081", "nexus.corp.example:8000-9000", "nexus.corp.example:http", "nexus.corp.example:+80"]) expect(refusal(text), text).toBe("bad_port");
  });

  it("refuses the metadata service in every spelling, with or without a port", () => {
    for (const text of ["169.254.169.254:80", "169.254.169.254", "169.254.170.2:80", "169.254.169.253:53", "100.100.100.200:80", "[fd00:ec2::254]:80", "[FD00:EC2:0:0:0:0:0:254]:80", "fd00:ec2::254",
      "[::ffff:169.254.169.254]:80", "[::ffff:a9fe:a9fe]:80", "instance-data.ec2.internal:80", "metadata.google.internal:80"]) expect(refusal(text), text).toBe("metadata");
  });

  it("refuses loopback and link-local in every spelling", () => {
    for (const text of ["127.0.0.1:8081", "127.10.0.1:80", "0.0.0.0:80", "[::1]:80", "[::]:80", "localhost:80", "a.localhost:80", "[::ffff:127.0.0.1]:80"]) expect(refusal(text), text).toBe("loopback");
    for (const text of ["169.254.1.1:80", "[fe80::1]:80"]) expect(refusal(text), text).toBe("link_local");
  });

  it("refuses IPv6, which the task network does not carry", () => {
    for (const text of ["[fd12:3456::1]:443", "fd12:3456::1", "[2001:db8::1]:443", "[fd12::1", "nexus:corp:443"]) expect(refusal(text), text).toBe("ipv6");
  });

  it("refuses decimal, octal, hex and short IPv4 forms, which some resolvers read as another address", () => {
    for (const text of ["167772161:80", "0x0a000001:80", "012.0.0.1:80", "10.020.0.1:80", "0x0a.0.0.1:80", "10.1:80", "10.0.1:80", "10.0.0.256:80", "1.2.3.4.5:80", "nexus.1:80", "nexus.0x1:80"]) expect(refusal(text), text).toBe("ip_form");
  });

  it("refuses a trailing dot and names that are not full host names", () => {
    expect(refusal("nexus.corp.example.:443")).toBe("trailing_dot");
    expect(refusal("10.20.0.15.:443")).toBe("trailing_dot");
    for (const text of ["nexus:443", "nexus..corp:443", "-nexus.corp:443", "nexus_1.corp:443", "nex us.corp:443", ":443", "ünïcode.example:443"]) expect(refusal(text), text).toBe("bad_name");
  });

  it("refuses public addresses (they need no entry) and the worker's own container ranges", () => {
    for (const text of ["8.8.8.8:53", "52.1.2.3:443", "224.0.0.1:80", "255.255.255.255:80"]) expect(refusal(text), text).toBe("not_private");
    for (const text of ["172.17.0.1:80", "172.18.0.5:80", "172.22.1.1:80", "172.29.0.2:53", "172.30.0.1:80", "172.31.0.9:443", "192.168.1.10:443"]) expect(refusal(text), text).toBe("worker_network");
  });

  it("refuses the install's own network and the names of its own services", () => {
    for (const text of ["10.42.0.2:53", "10.42.128.7:5432", "10.42.255.255:443"]) expect(refusal(text), text).toBe("install_network");
    for (const text of ["internal-rovara-proxy-123.us-east-1.elb.amazonaws.com:4000", "API.rovara.example:443", "ip-10-42-1-2.ec2.internal:22", "ip-10-1-2-3.us-west-2.compute.internal:80"]) expect(refusal(text), text).toBe("install_service");
    // Another install's network is just a private range.
    expect(checkPrivateAddress("10.42.0.2:53", { vpcCidrs: ["10.50.0.0/16"], serviceHosts: [] }).ok).toBe(true);
  });

  it("refuses an empty or over-long entry", () => {
    expect(refusal("  ")).toBe("empty");
    expect(refusal(`${"a".repeat(92)}.example:443`)).toBe("too_long");
  });

  it("has words for every refusal that name the position and never echo the entry", () => {
    for (const code of [...PRIVATE_ADDRESS_REFUSALS, "duplicate", "too_many"] as const) {
      const text = privateAddressRefusalText(2, code);
      expect(text.startsWith("Entry 3 ")).toBe(true);
      expect(text).not.toContain("nexus.corp.example:8082");
    }
  });
});

describe("a list", () => {
  it("is sorted and deduplicated by refusal, at most 16 entries, with a digest of its sorted form", () => {
    const checked = checkPrivateAddressList(["nexus.corp.example:8081", "10.20.0.15:443"], INSTALL);
    expect(checked).toEqual({ ok: true, entries: ["10.20.0.15:443", "nexus.corp.example:8081"] });
    expect(checkPrivateAddressList(["10.20.0.15:443", "10.20.0.15:443 "], INSTALL)).toEqual({ ok: false, index: 1, refusal: "duplicate" });
    expect(checkPrivateAddressList(["10.20.0.15:443", "169.254.169.254:80"], INSTALL)).toEqual({ ok: false, index: 1, refusal: "metadata" });
    const many = Array.from({ length: PRIVATE_ADDRESSES_MAX + 1 }, (_, index) => `10.20.0.${String(index + 1)}:443`);
    expect(checkPrivateAddressList(many, INSTALL)).toMatchObject({ ok: false, refusal: "too_many" });
    expect(checkPrivateAddressList(many.slice(0, PRIVATE_ADDRESSES_MAX), INSTALL).ok).toBe(true);
    expect(privateAddressListDigest(["b:1", "a:1"])).toBe(privateAddressListDigest(["a:1", "b:1"]));
    expect(privateAddressListDigest([])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("at its longest still fits the worker's launch setting, which no shell character can enter", () => {
    const longest = Array.from({ length: PRIVATE_ADDRESSES_MAX }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(40)}.${"m".repeat(43)}.example:65535`);
    const checked = checkPrivateAddressList(longest, INSTALL);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(PRIVATE_ADDRESSES_BOOT_PATTERN.test(checked.entries.join(","))).toBe(true);
    for (const bad of ["a.b:1'", "a.b:1;reboot", "a.b:1 ,c.d:2", "a.b:1,", "A.b:1", "$(x).b:1"]) expect(PRIVATE_ADDRESSES_BOOT_PATTERN.test(bad), bad).toBe(false);
  });

  it("is sent whole by the route's strict body", () => {
    expect(PrivateAddressesBodySchema.safeParse({ action: "propose", expectedRevision: 0, entries: ["10.20.0.15:443"] }).success).toBe(true);
    expect(PrivateAddressesBodySchema.safeParse({ action: "propose", expectedRevision: 0, entries: ["10.20.0.15:443"], extra: 1 }).success).toBe(false);
    expect(PrivateAddressesBodySchema.safeParse({ action: "approve", changeId: "c-1", expectedDigest: "0".repeat(64) }).success).toBe(true);
    expect(PrivateAddressesBodySchema.safeParse({ action: "approve", changeId: "c-1" }).success).toBe(false);
  });
});

describe("the install the broker knows", () => {
  it("defaults to the production foundation's network and adds the proxy's and control plane's hosts", () => {
    expect(INSTALL_VPC_CIDR_DEFAULT).toBe(AGENTX_PRODUCTION_VPC_CIDR);
    expect(privateAddressInstallOf({})).toEqual({ vpcCidrs: [AGENTX_PRODUCTION_VPC_CIDR], serviceHosts: [] });
    expect(privateAddressInstallOf({ ROVARA_VPC_CIDRS: "10.1.0.0/16, 10.2.0.0/16", MODEL_PROXY_URL: "http://Internal-X.us-east-1.elb.amazonaws.com:4000", CONTROL_PLANE_URL: "https://api.example.com/v1" }))
      .toEqual({ vpcCidrs: ["10.1.0.0/16", "10.2.0.0/16"], serviceHosts: ["internal-x.us-east-1.elb.amazonaws.com", "api.example.com"] });
    expect(ipv4Number("10.42.0.2")).toBe(0x0a2a0002);
  });
});
