// Internal addresses a company's tasks may reach (owner decision 123, 0.5.15): the shapes of `/v1/app/org/private-addresses` and the ONE rule for what an entry may be.
//
// 0.5.15's sandbox walls drop every private address from task sandboxes and dev containers (the rvbtask bridge, packages/worker/ec2/boot.sh `wall_off_containers`). A company that installs packages from an internal
// mirror (a private npm, PyPI or Maven server, Artifactory or Nexus on a private address) lists the EXACT addresses here, and its tasks' walls let those host:port pairs through and nothing else.
//
// An entry is `host:port` or `IPv4:port`, written exactly:
//   - no wildcard, no range of addresses (CIDR) and no range of ports: one host, one port;
//   - IPv4 only, as four plain decimal numbers (no decimal, octal, hex or short forms, which some resolvers read as another address); IPv6 is refused (the task network carries IPv4 only);
//   - a name is a full name with at least one dot, lower case, without a trailing dot;
//   - never the metadata service (169.254.169.254, fd00:ec2::254 and the other link-local services), loopback or link-local, never an address the worker's own containers use (172.17-172.31, 192.168),
//     never the network Rovara itself runs in (the install's VPC: its model proxy load balancer, database, VPC resolver and broker all live there), and never a name of the install's own services.
// The same rule runs in the browser (to say what is wrong before a press), at the route (on every proposal and approval), and at launch (a list stored before a rule tightened is checked again). The worker
// repeats the address checks on what each name resolves to when it applies the wall (packages/worker/ec2/boot-stage2.sh `rovara-private-allow`), with the install's network read from the instance itself.
// Pure: no clock, no network, no Node module.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";

export const PRIVATE_ADDRESSES_PATH = "/v1/app/org/private-addresses";
/** At most this many entries per company. Each one is a hole in the wall, and the list rides in the worker's launch settings. */
export const PRIVATE_ADDRESSES_MAX = 16;
/** The longest entry, `host:port` together. */
export const PRIVATE_ADDRESS_MAX_CHARS = 100;
/** How long a proposal waits for a second admin. */
export const PRIVATE_ADDRESS_PROPOSAL_TTL_MS = 7 * 86_400_000;
/** The launch setting the worker reads the approved list from (comma separated entries). */
export const PRIVATE_ADDRESSES_BOOT_VARIABLE = "AGENTX_PRIVATE_ADDRESSES";
/** What that setting may hold: entries as this file writes them, comma separated, nothing a shell would read. */
export const PRIVATE_ADDRESSES_BOOT_PATTERN = /^[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}(?:,[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}){0,15}$/u;

/** Owner decision 128: the partition where a list change that removed anything leaves its mark (sort key: the org id) for the session reaper, which recycles that company's workers launched before it. */
export const PRIVATE_ADDRESS_RECYCLE_PK = "PRIVATEADDR#RECYCLE";

/** Why an entry is refused. Fixed codes: an answer names the code and the entry's position, never echoes the text. */
export const PRIVATE_ADDRESS_REFUSALS = [
  "empty", "too_long", "scheme_or_path", "wildcard", "cidr", "missing_port", "bad_port", "ipv6", "ip_form", "trailing_dot", "bad_name",
  "metadata", "loopback", "link_local", "not_private", "worker_network", "install_network", "install_service", "reserved_range", "not_routed", "port_not_open",
] as const;
export type PrivateAddressRefusal = (typeof PRIVATE_ADDRESS_REFUSALS)[number];

export const PRIVATE_ADDRESS_REFUSAL_WORDS: Record<PrivateAddressRefusal | "duplicate" | "too_many", string> = {
  empty: "is empty.",
  too_long: `is longer than ${String(PRIVATE_ADDRESS_MAX_CHARS)} characters.`,
  scheme_or_path: "must be a host and a port only, such as nexus.corp.example:8081, without http:// or a path.",
  wildcard: "has a wildcard. List each host and port exactly.",
  cidr: "is a range of addresses. List each host and port exactly.",
  missing_port: "has no port. Add the one port the server listens on, such as :443.",
  bad_port: "has a port that is not one number from 1 to 65535.",
  ipv6: "is an IPv6 address. Task networks carry IPv4 only; use the server's IPv4 address or its name.",
  ip_form: "is not an IPv4 address written as four plain numbers (such as 10.20.0.15).",
  trailing_dot: "ends in a dot. Write the name without it.",
  bad_name: "is not a full host name (letters, digits, hyphens and at least one dot, such as nexus.corp.example).",
  metadata: "is the cloud metadata service, which tasks can never reach.",
  loopback: "is a loopback address, which tasks can never reach.",
  link_local: "is a link-local address, which tasks can never reach.",
  not_private: "is not a private address. Public addresses need no entry here.",
  worker_network: "is inside a range the worker's own containers use (172.17.0.0 to 172.30.255.255, and 192.168.0.0/16).",
  install_network: "is inside the network Rovara itself runs in.",
  install_service: "names one of Rovara's own services.",
  reserved_range: "is inside a range this install already gives to private MCP servers or model endpoints. Those servers are reached through their own settings, never from a task.",
  not_routed: "is outside the private ranges this install routes to. The operator sets those ranges when installing Rovara.",
  port_not_open: "uses a port that workers may not open on this install. Ask the operator to add the port to rovaraPrivateAddressPorts, or use a port that is open.",
  duplicate: "is listed twice.",
  too_many: `is one too many: at most ${String(PRIVATE_ADDRESSES_MAX)} entries.`,
};

/**
 * What an install knows about itself: its own network (CIDR ranges) and the host names of its own services, and, at the route (the broker reads them from its settings; a launch does not know them and leaves them out):
 * the ranges other settings own (private MCP servers, model endpoints), the private ranges the install routes to, and the ports its workers may open there. Absent: not checked.
 */
export interface PrivateAddressInstall {
  vpcCidrs: readonly string[];
  serviceHosts: readonly string[];
  reservedCidrs?: readonly string[];
  routedCidrs?: readonly string[];
  openPorts?: readonly number[];
}

export type PrivateAddressCheck =
  | { ok: true; entry: string; host: string; port: number; kind: "ip" | "name" }
  | { ok: false; refusal: PrivateAddressRefusal };

// ---- IPv4, written exactly

/** The address as a 32-bit number, or undefined unless it is four plain decimal numbers 0-255 without leading zeros. */
export function ipv4Number(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** A range `a.b.c.d/n` as its first address and size, or undefined when it does not parse. */
function ipv4Range(cidr: string): { first: number; size: number } | undefined {
  const [network, prefixText, extra] = cidr.split("/");
  if (network === undefined || prefixText === undefined || extra !== undefined || !/^[0-9]{1,2}$/u.test(prefixText)) return undefined;
  const base = ipv4Number(network), prefix = Number(prefixText);
  if (base === undefined || prefix > 32) return undefined;
  const size = 2 ** (32 - prefix);
  return { first: base - (base % size), size };
}

/** Whether the address is inside the range. A range that does not parse contains everything (fail closed: the address is then refused, never let through). */
export function ipv4InRange(address: number, cidr: string): boolean {
  const range = ipv4Range(cidr);
  return range === undefined || (address >= range.first && address < range.first + range.size);
}

const METADATA_IPV4 = ["169.254.169.254", "169.254.169.253", "169.254.169.123", "169.254.170.2", "169.254.170.23", "100.100.100.200"];
const LOOPBACK_IPV4 = ["127.0.0.0/8", "0.0.0.0/8"];
const LINK_LOCAL_IPV4 = ["169.254.0.0/16"];
/** The private ranges an entry may be in (RFC 1918 and the shared address space). Anything else is public, multicast or reserved. */
export const PRIVATE_ADDRESS_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"] as const;
/**
 * The ranges a worker's own Docker networks use, inside the private ranges: docker0 (172.17/16), the address pools of run, setup and dev networks (172.18-172.28 and 192.168/16), setup runs (172.29/16) and run
 * networks (172.30/16) (packages/worker/ec2/boot-stage2.sh `set_docker_address_pools`). 172.31/16 is not one of them (no pool reaches it) and may be listed. 192.168/16 stays refused while Docker's pool holds it (follow-up:
 * move that pool). Traffic to these ranges stays on the worker, so an entry there would reach another task's containers, never the company's server.
 */
export const WORKER_NETWORK_RANGES = ["172.17.0.0/16", "172.18.0.0/15", "172.20.0.0/14", "172.24.0.0/14", "172.28.0.0/15", "172.30.0.0/16", "192.168.0.0/16"] as const;

/** The refusal for an IPv4 address (`undefined`: it may be listed). Shared with the worker's own check of what a name resolves to, which repeats it in shell. */
export function ipv4Refusal(address: number, install: Pick<PrivateAddressInstall, "vpcCidrs" | "reservedCidrs" | "routedCidrs">): PrivateAddressRefusal | undefined {
  if (METADATA_IPV4.some((item) => ipv4Number(item) === address)) return "metadata";
  if (LOOPBACK_IPV4.some((range) => ipv4InRange(address, range))) return "loopback";
  if (LINK_LOCAL_IPV4.some((range) => ipv4InRange(address, range))) return "link_local";
  if (!PRIVATE_ADDRESS_RANGES.some((range) => ipv4InRange(address, range))) return "not_private";
  if (WORKER_NETWORK_RANGES.some((range) => ipv4InRange(address, range))) return "worker_network";
  // No install network known is no network to compare with: the route refuses to work without one (see `privateAddressInstallOf` in the broker), and the worker reads its own.
  if (install.vpcCidrs.some((range) => ipv4InRange(address, range))) return "install_network";
  if ((install.reservedCidrs ?? []).some((range) => ipv4InRange(address, range))) return "reserved_range";
  if (install.routedCidrs !== undefined && !install.routedCidrs.some((range) => ipv4InRange(address, range))) return "not_routed";
  return undefined;
}

// ---- IPv6 (refused, but metadata and loopback are named as what they are)

/** The eight groups of an IPv6 address, or undefined. An embedded IPv4 tail (`::ffff:1.2.3.4`) becomes two groups. */
function ipv6Groups(text: string): number[] | undefined {
  let body = text.toLowerCase();
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/u.exec(body);
  if (tail?.[1] !== undefined) {
    const v4 = ipv4Number(tail[1]);
    if (v4 === undefined) return undefined;
    body = `${body.slice(0, body.length - tail[1].length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/u.test(body) || body.split("::").length > 2) return undefined;
  const [head = "", rest] = body.split("::");
  const left = head === "" ? [] : head.split(":"), right = rest === undefined || rest === "" ? [] : rest.split(":");
  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return undefined;
  return [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right].map((group) => parseInt(group, 16));
}

function ipv6Refusal(text: string): PrivateAddressRefusal {
  const groups = ipv6Groups(text);
  if (groups === undefined) return "ipv6";
  const same = (other: number[]) => other.every((value, index) => groups[index] === value);
  if (same([0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254])) return "metadata";
  if (same([0, 0, 0, 0, 0, 0, 0, 1]) || same([0, 0, 0, 0, 0, 0, 0, 0])) return "loopback";
  if ((groups[0]! & 0xffc0) === 0xfe80) return "link_local";
  // An IPv4 address written as IPv6 (mapped or compatible) is judged as that address, so 169.254.169.254 cannot be written another way.
  if (groups.slice(0, 5).every((value) => value === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = groups[6]! * 65536 + groups[7]!;
    const refusal = ipv4Refusal(v4, { vpcCidrs: [] });
    if (refusal === "metadata" || refusal === "loopback" || refusal === "link_local") return refusal;
  }
  return "ipv6";
}

// ---- names

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/u;
/** Names that are the metadata service on some cloud, whatever they resolve to here. */
const METADATA_NAMES = ["instance-data", "instance-data.ec2.internal", "metadata.google.internal", "metadata.internal"];
/** Suffixes of names AWS gives the machines of the VPC a resolver answers for: in Rovara's VPC, Rovara's own machines. */
const INSTALL_NAME_SUFFIXES = [".compute.internal", ".ec2.internal"];

function nameRefusal(host: string, install: PrivateAddressInstall): PrivateAddressRefusal | undefined {
  const labels = host.split(".");
  // Every label a number (decimal, octal or hex): an IPv4 address in a form some resolvers accept (`167772161`, `012.0.0.1`, `0x0a.0.0.1`, `10.1`). Only the plain four-number form is an address here.
  if (labels.every((label) => NUMERIC_LABEL.test(label))) return "ip_form";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return "bad_name";
  // A last label that is a number reads as an address to some resolvers (`nexus.1`).
  if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) return "ip_form";
  if (METADATA_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) return "metadata";
  if (INSTALL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "install_service";
  if (install.serviceHosts.some((service) => service.toLowerCase().replace(/\.$/u, "") === host)) return "install_service";
  return undefined;
}

/** One entry, checked. The entry is returned in its one written form (lower case). */
export function checkPrivateAddress(text: string, install: PrivateAddressInstall): PrivateAddressCheck {
  const value = text.trim().toLowerCase();
  if (value === "") return { ok: false, refusal: "empty" };
  if (value.length > PRIVATE_ADDRESS_MAX_CHARS) return { ok: false, refusal: "too_long" };
  if (value.includes("*")) return { ok: false, refusal: "wildcard" };
  if (value.includes("://") || value.includes("@") || value.includes("?") || value.includes("#")) return { ok: false, refusal: "scheme_or_path" };
  if (value.includes("/")) return /^[0-9a-fx.:[\]]+\/[0-9]{1,3}(?::[0-9]*)?$/u.test(value) ? { ok: false, refusal: "cidr" } : { ok: false, refusal: "scheme_or_path" };
  // IPv6: bracketed (`[fd00:ec2::254]:80`) or bare with more than one colon.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return { ok: false, refusal: close === -1 ? "ipv6" : ipv6Refusal(value.slice(1, close)) };
  }
  if ((value.match(/:/gu) ?? []).length > 1) return { ok: false, refusal: ipv6Refusal(value) };
  const colon = value.lastIndexOf(":");
  if (colon === -1) {
    // A bare IPv6-free host: say what the host itself is first when it can never be listed (the metadata service without a port is still the metadata service).
    const bare = ipv4Number(value);
    if (bare !== undefined) return { ok: false, refusal: ipv4Refusal(bare, install) ?? "missing_port" };
    return { ok: false, refusal: "missing_port" };
  }
  const host = value.slice(0, colon), portText = value.slice(colon + 1);
  if (host === "") return { ok: false, refusal: "bad_name" };
  if (portText === "") return { ok: false, refusal: "missing_port" };
  if (!/^[1-9][0-9]{0,4}$/u.test(portText) || Number(portText) > 65_535) return { ok: false, refusal: "bad_port" };
  const port = Number(portText);
  if (host.endsWith(".")) return { ok: false, refusal: "trailing_dot" };
  if (install.openPorts !== undefined && !install.openPorts.includes(port)) return { ok: false, refusal: "port_not_open" };
  if (/[^a-z0-9.-]/u.test(host)) return { ok: false, refusal: "bad_name" };
  const address = ipv4Number(host);
  if (address !== undefined) {
    const refusal = ipv4Refusal(address, install);
    return refusal === undefined ? { ok: true, entry: `${host}:${String(port)}`, host, port, kind: "ip" } : { ok: false, refusal };
  }
  const refusal = nameRefusal(host, install);
  return refusal === undefined ? { ok: true, entry: `${host}:${String(port)}`, host, port, kind: "name" } : { ok: false, refusal };
}

export type PrivateAddressListCheck =
  | { ok: true; entries: string[] }
  | { ok: false; index: number; refusal: PrivateAddressRefusal | "duplicate" | "too_many" };

/** A whole list: every entry checked, none twice, at most PRIVATE_ADDRESSES_MAX. Returned sorted, so one set of entries has one stored form and one digest. */
export function checkPrivateAddressList(texts: readonly string[], install: PrivateAddressInstall): PrivateAddressListCheck {
  if (texts.length > PRIVATE_ADDRESSES_MAX) return { ok: false, index: PRIVATE_ADDRESSES_MAX, refusal: "too_many" };
  const seen = new Set<string>();
  for (const [index, text] of texts.entries()) {
    const checked = checkPrivateAddress(text, install);
    if (!checked.ok) return { ok: false, index, refusal: checked.refusal };
    if (seen.has(checked.entry)) return { ok: false, index, refusal: "duplicate" };
    seen.add(checked.entry);
  }
  return { ok: true, entries: [...seen].sort() };
}

/** The words for a refused list: the entry's position (1-based) and what is wrong, never the entry's text. */
export function privateAddressRefusalText(index: number, refusal: PrivateAddressRefusal | "duplicate" | "too_many"): string {
  return `Entry ${String(index + 1)} ${PRIVATE_ADDRESS_REFUSAL_WORDS[refusal]}`;
}

// ---- the route's shapes

const Entry = z.string().min(1).max(PRIVATE_ADDRESS_MAX_CHARS);
const ChangeId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const PrivateAddressesStateSchema = z.object({
  /** The revision a proposal is made against. 0: nothing approved yet. */
  revision: z.number().int().min(0),
  /** The approved entries, sorted. */
  entries: z.array(Entry).max(PRIVATE_ADDRESSES_MAX),
  digest: Digest,
  max: z.literal(PRIVATE_ADDRESSES_MAX),
  /** The ports workers may open toward the install's private ranges (443 and the operator's rovaraPrivateAddressPorts). */
  openPorts: z.array(z.number().int().min(1).max(65_535)).max(16),
  /** True for a company owner or admin (only they read this page). */
  canChange: z.boolean(),
  /** The stored list could not be read: no worker of the company starts until it is saved again (any save replaces it). */
  unreadable: z.literal(true).optional(),
  /** A proposal waits for a different admin. At most one at a time. */
  pending: z.object({
    changeId: ChangeId, entries: z.array(Entry).max(PRIVATE_ADDRESSES_MAX), digest: Digest, added: z.array(Entry).max(PRIVATE_ADDRESSES_MAX), removed: z.array(Entry).max(PRIVATE_ADDRESSES_MAX),
    proposedByYou: z.boolean(), expiresAt: z.string().datetime(),
  }).strict().optional(),
}).strict();
export type PrivateAddressesState = z.infer<typeof PrivateAddressesStateSchema>;
export const PrivateAddressesStateReaderSchema = forwardReader(PrivateAddressesStateSchema);

export const PrivateAddressesBodySchema = z.discriminatedUnion("action", [
  /** The whole new list. Only removals: applied at once (the stricter side). Anything added: a proposal for a DIFFERENT admin (202 needs_approval). */
  z.object({ action: z.literal("propose"), expectedRevision: z.number().int().min(0), entries: z.array(Entry).max(PRIVATE_ADDRESSES_MAX + 1) }).strict(),
  /** A different admin approves the waiting proposal they were shown (its digest), signed in within the last 10 minutes. */
  z.object({ action: z.literal("approve"), changeId: ChangeId, expectedDigest: Digest }).strict(),
  /** Withdraws or turns down the waiting proposal (its proposer, or any admin). */
  z.object({ action: z.literal("withdraw"), changeId: ChangeId }).strict(),
]);
export type PrivateAddressesBody = z.infer<typeof PrivateAddressesBodySchema>;

/** Things to check that do not refuse the list, in fixed words naming an entry's position (a name not on the install's allowed websites, so tasks may not be able to look it up). */
const Warnings = z.array(z.string().min(1).max(300)).max(PRIVATE_ADDRESSES_MAX).optional();
export const PrivateAddressesAnswerSchema = z.discriminatedUnion("status", [
  PrivateAddressesStateSchema.extend({ status: z.literal("applied"), warnings: Warnings }).strict(),
  PrivateAddressesStateSchema.extend({ status: z.literal("needs_approval"), changeId: ChangeId, warnings: Warnings }).strict(),
  PrivateAddressesStateSchema.extend({ status: z.literal("withdrawn") }).strict(),
]);
export type PrivateAddressesAnswer = z.infer<typeof PrivateAddressesAnswerSchema>;
export const PrivateAddressesAnswerReaderSchema = forwardReader(PrivateAddressesAnswerSchema);
