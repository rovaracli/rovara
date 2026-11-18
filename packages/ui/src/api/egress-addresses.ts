// L4-EGR: Rovara's outbound addresses, for the read-only line in Company settings (owners and admins). Cloud answers from Rovara Code as the signed-in person
// (packages/cloud-server/src/egress-addresses-routes.ts). The reader is total over untrusted data: a body that is not exactly `{ addresses }` with up to four distinct public IPv4
// addresses throws ("couldn't be read"), never half drawn. The addresses are public and the same for every company on this Rovara.
export const EGRESS_ADDRESSES_PATH = "/v1/app/org/egress-addresses";
/** The days of notice Rovara promises before any of the addresses changes (Code's EGRESS_ADDRESS_NOTICE_DAYS). */
export const EGRESS_NOTICE_DAYS = 30;
const MAX = 4;

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`, "u");
function nonPublic(address: string): boolean {
 const [a, b] = address.split(".").map(Number) as [number, number];
 return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function readEgressAddresses(body: unknown): string[] {
 if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not Rovara's outbound addresses");
 const keys = Object.keys(body);
 const addresses = (body as { addresses?: unknown }).addresses;
 if (keys.length !== 1 || keys[0] !== "addresses" || !Array.isArray(addresses) || addresses.length > MAX) throw new Error("not Rovara's outbound addresses");
 if (!addresses.every(entry => typeof entry === "string" && IPV4.test(entry) && !nonPublic(entry)) || new Set(addresses).size !== addresses.length) throw new Error("not Rovara's outbound addresses");
 return (addresses as string[]).slice();
}
