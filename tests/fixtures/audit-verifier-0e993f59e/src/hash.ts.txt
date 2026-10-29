import { createHash } from "node:crypto";

/** Lowercase hex SHA-256. A string is hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
