// Owner decision 123: the digest of a company's internal address list (app-private-addresses.ts). Server side only: the browser is sent the digest and never computes one, so the web entry carries no hash code.
import { sha256Hex } from "./web-hash.js";

/** The list's digest: sha256 of the sorted entries, one per line. The empty list has a digest too. */
export function privateAddressListDigest(entries: readonly string[]): string {
  return sha256Hex([...entries].sort().join("\n"));
}
