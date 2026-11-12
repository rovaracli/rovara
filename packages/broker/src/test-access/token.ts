// Customer test AWS account, lane TA2 (customer-test-account.md section 1): the connect token, the connection id and the run id.
//
// The connect token is the ONLY thing that authenticates a callback (the topic takes publishes from any AWS account), so:
//   - it is 256 bits from the platform's random source, shown once (in the link) and never stored: the store keeps `connectTokenHash` (a domain-separated SHA-256), and a lookup is by that hash, so a stolen table
//     cannot be turned back into a token, and a guess has nothing to compare against but a 256-bit space;
//   - it is single use (one conditional write in the store), bound to one organization, project and connection, and short lived (30 minutes);
//   - it is never logged, never put in an error, an audit event or a response other than the link of the one request that minted it.
// Nothing here reads the clock or the network.
import { createHash, randomBytes, randomInt } from "node:crypto";

export const CONNECT_TOKEN_BYTES = 32;
/** The token's shape: base64url, what the template's `ConnectToken` parameter accepts (`^[A-Za-z0-9_-]{16,256}$`). */
export const CONNECT_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/u;
const TOKEN_HASH_DOMAIN = "rovara:test-access:connect-token:v1:";
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A new token: 32 random bytes as base64url (43 characters). `random` is a test seam. */
export function mintConnectToken(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(CONNECT_TOKEN_BYTES);
  if (bytes.length !== CONNECT_TOKEN_BYTES) throw new Error("the random source returned the wrong number of bytes");
  return Buffer.from(bytes).toString("base64url");
}

/** What the store keeps in place of the token. Undefined for text that cannot be a token, so a malformed value never reaches a lookup. */
export function connectTokenHash(token: string): string | undefined {
  if (!CONNECT_TOKEN_SHAPE.test(token)) return undefined;
  return createHash("sha256").update(TOKEN_HASH_DOMAIN, "utf8").update(token, "utf8").digest("hex");
}

const randomId = (length: number, pick: (max: number) => number): string => Array.from({ length }, () => ID_ALPHABET[pick(ID_ALPHABET.length)]).join("");

/** `conn_` and 20 lower-case letters and digits, chosen without bias (`randomInt` rejects the modulo remainder). `pick` is a test seam. */
export function newConnectionId(pick: (max: number) => number = randomInt): string {
  return `conn_${randomId(20, pick)}`;
}

/** The 8 characters that name a run in the session tag and in every name the run creates. Lower-case letters and digits only. */
export function newRunId(pick: (max: number) => number = randomInt): string {
  return randomId(8, pick);
}
