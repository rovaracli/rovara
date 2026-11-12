// Which hosts named in a repository's settings files are a dependency the tests could reach, and which are not: private and cloud-metadata addresses, documentation and website links, badge hosts and source-code
// forges. A listing of "services not set up yet" that is mostly links to documentation (and `10.0.0.5`, `169.254.169.254`) is noise a person has to read before the real ones.
// Pure and bounded: no lookups, no network. Only an address's own range is judged here (a name's address is never resolved).
import { BlockList, isIP } from "node:net";

/** Ranges that name no outside service: this machine, private networks (RFC 1918, shared address space, unique local), link-local and cloud-metadata (169.254.0.0/16 holds 169.254.169.254), multicast, documentation and benchmarking. */
const NOT_A_SERVICE: ReadonlyArray<[string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["100.100.100.200", 32, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"], ["fd00:ec2::", 32, "ipv6"],
];
const NOT_A_SERVICE_LIST = (() => {
  const list = new BlockList();
  for (const [network, prefix, family] of NOT_A_SERVICE) list.addSubnet(network, prefix, family);
  return list;
})();

/** Whether an IP address is private, loopback, link-local, cloud-metadata, multicast, reserved or documentation. An IPv4 address written as IPv6 (`::ffff:169.254.169.254`) is judged by its IPv4 address. */
export function isNonServiceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped?.[1] !== undefined) return NOT_A_SERVICE_LIST.check(mapped[1], "ipv4");
  return NOT_A_SERVICE_LIST.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Names that are always local, reserved, a namespace, documentation, a badge, a package registry or a code forge (the web page of a project, never a service it calls). `api.github.com` is none of these. */
const NOT_A_SERVICE_NAMES: readonly RegExp[] = [
  // Local and reserved (RFC 6761 / 6762 / 8375) and private-network suffixes.
  /^localhost$/u, /\.(?:localhost|local|localdomain|internal|intranet|lan|corp|test|invalid|example)$/u, /\.home\.arpa$/u, /(?:^|\.)example\.(?:com|org|net)$/u,
  // Namespaces and schemas.
  /^(?:www\.)?w3\.org$/u, /^json-schema\.org$/u, /^schemas?\.[a-z.]+$/u, /^xmlns\.com$/u, /^purl\.org$/u, /^opensource\.org$/u, /^(?:www\.)?openapis\.org$/u, /^swagger\.io$/u, /^spdx\.org$/u,
  // Documentation and reference sites.
  /^(?:docs?|documentation|wiki|devdocs|readthedocs)\./u, /(?:^|\.)readthedocs\.(?:io|org)$/u, /\.github\.io$/u, /^learn\.microsoft\.com$/u, /^developer\.mozilla\.org$/u,
  /^(?:www\.)?(?:apache|gnu|creativecommons|ietf|rfc-editor|wikipedia|stackoverflow|medium|youtube|youtu|twitter|x|linkedin)\.(?:org|com|be|net)$/u, /^[a-z]{2,3}\.wikipedia\.org$/u, /^tools\.ietf\.org$/u,
  // Badges and project-health pages that a README or a manifest links.
  /(?:^|\.)(?:shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|coveralls\.io|travis-ci\.(?:org|com)|snyk\.io|sonarcloud\.io|codacy\.com|libraries\.io|david-dm\.org|bestpractices\.dev|gitter\.im)$/u,
  // Package registries and source forges: where code is fetched or read, not what it calls.
  /^(?:www\.|gist\.)?(?:github|gitlab|gitea|bitbucket|codeberg)\.(?:com|org|io|net)$/u, /^(?:github|gitlab|gitea|git|gerrit)\./u, /(?:^|\.)githubusercontent\.com$/u,
  /^raw\.githubusercontent\.com$/u, /^(?:www\.)?(?:pypi|npmjs)\.org$/u, /^(?:www\.)?npmjs\.com$/u, /^files\.pythonhosted\.org$/u, /^registry\.(?:npmjs\.org|yarnpkg\.com)$/u,
];

/** Document pages and forge pages by their path: `README.md`, `docs/setup.rst`, `/owner/repo/blob/main/x`, `/owner/repo/issues/12`. */
const NOT_A_SERVICE_PATH = /\.(?:md|markdown|mdx|rst|adoc)$|^\/[^/]+\/[^/]+\/(?:blob|tree|issues|pull|pulls|wiki|releases|commit|commits|actions|discussions)(?:\/|$)/u;

/**
 * Whether a host (lower case, no port) named in a settings file could be a service the tests reach. False for a private, loopback, link-local or cloud-metadata address (an IP address is judged by its range alone), a name
 * that is local, documentation, a badge, a registry or a code forge, and a name that is not a hostname at all (no letters in its last label: `127.1`, `0x7f.1`). A public IP address and an ordinary hostname are kept. `path`
 * is the URL's path, when the caller has it: a link to a document or to a code page of a forge is not a service either.
 */
export function isDependencyHost(host: string, path?: string): boolean {
  if (!host.includes(".")) return false;
  if (isIP(host) !== 0) return !isNonServiceAddress(host);
  if (!/^[a-z0-9-]*[a-z][a-z0-9-]*$/u.test(host.split(".").at(-1) ?? "")) return false;
  if (NOT_A_SERVICE_NAMES.some((pattern) => pattern.test(host))) return false;
  return !(path !== undefined && NOT_A_SERVICE_PATH.test(path.split(/[?#]/u)[0] ?? ""));
}

/** The settings whose value is a link to a page about the project, not something it calls (`"homepage": "https://..."`, `Documentation = "..."`, `$schema:`). */
const LINK_KEY = /["']?(?:homepage|home[-_]?page|documentation|docs|doc[-_]?url|repository|repo|bugs|issues|funding|changelog|licen[cs]e|website|readme|tracker|\$schema|\$id|schemaLocation)["']?\s*[:=]\s*(?:["'[{]\s*(?:["']?url["']?\s*[:=]\s*)?)*$/iu;

/** Whether the text before a URL on its line is the key of a link to a page about the project. */
export function followsLinkKey(textBeforeUrlOnItsLine: string): boolean {
  return LINK_KEY.test(textBeforeUrlOnItsLine);
}
