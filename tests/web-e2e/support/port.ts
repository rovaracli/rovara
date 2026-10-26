import { createHash } from "node:crypto";
export function mockCellPort(path = process.cwd()): number { return 4500 + createHash("sha256").update(path).digest().readUInt16BE(0) % 400; }
export const mockCellOrigin = () => `https://127.0.0.1:${mockCellPort()}`;
