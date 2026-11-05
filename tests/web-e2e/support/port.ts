import { createHash } from "node:crypto";
/** Each Playwright worker slot (its parallelIndex, 0 to workers - 1) has its own mock cell process: it is started with this variable set, and everything in that process reads its port from here. */
export const SLOT_ENV = "ROVARA_E2E_SLOT";
const slotOfThisProcess = () => { const value = Number(process.env[SLOT_ENV] ?? "0");return Number.isInteger(value) && value >= 0 && value < 64 ? value : 0; };
/** Slot 0 keeps the one port a worktree always had (4500 to 4899, from a hash of the worktree path); slot n takes the port 37 places further on, wrapping inside that range, so the slots of one worktree never meet. */
export function mockCellPort(path = process.cwd(), slot = slotOfThisProcess()): number { return 4500 + (createHash("sha256").update(path).digest().readUInt16BE(0) + slot * 37) % 400; }
export const mockCellOrigin = (slot = slotOfThisProcess()) => `https://127.0.0.1:${mockCellPort(process.cwd(), slot)}`;
