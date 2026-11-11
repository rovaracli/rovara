// Whether an IP address (as `dns.lookup` or a URL gives it) is a public, globally routable one. Used before the broker or the mirror contacts a registry: a registry's name must resolve ONLY to such addresses, so a name that
// points into the VPC, at the metadata service or at a loopback or private address is refused whatever the name looks like. Conservative: anything that is not clearly global unicast is not public.
import { isIP } from "node:net";

function ipv4Public(parts: readonly number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. Handles `::` and a trailing dotted IPv4. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) return undefined;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (tail !== null) {
    const octets = tail.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    text = `${text.slice(0, tail.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(fill).fill("0"), ...rest];
  const groups = all.map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Public(address.split(".").map(Number));
  if (kind !== 6) return false;
  const groups = ipv6Groups(address);
  if (groups === undefined) return false;
  const g0 = groups[0]!;
  // Global unicast is 2000::/3. Everything else (loopback, unspecified, unique local, link local, multicast, IPv4-mapped and NAT64 forms, site local) is not public.
  if ((g0 & 0xe000) !== 0x2000) return false;
  // Inside 2000::/3: documentation (2001:db8::/32), Teredo (2001::/32), 6to4 (2002::/16, carries an IPv4 address), ORCHID and benchmarking ranges.
  if (g0 === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0 || groups[1]! < 0x0200)) return false;
  if (g0 === 0x2002) return false;
  return true;
}

/** The `dns.lookup(host, { all: true })` shape. */
export type AddressLookup = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

/** True only when the name resolves, to at least one address, and to public addresses only. A lookup that fails or answers nothing is false. */
export async function resolvesOnlyToPublicAddresses(host: string, lookup: AddressLookup): Promise<boolean> {
  try {
    if (isIP(host) !== 0) return false;
    const found = await lookup(host);
    return found.length > 0 && found.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}
