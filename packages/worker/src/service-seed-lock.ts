// SEED-RISK-1: the worker's half of a seed command's lock. Right before a locked seed command runs (the first seeding of a phase and every reseed after a reset, working phase and sealed rounds alike), the repository
// text it resolves to is hashed again from the checkout AS IT IS NOW (the candidate tree: the agent may have changed it), with the SAME resolver the broker used (contracts seed-script-lock.ts). A difference, or
// anything that cannot be read, refuses the seed: it never runs changed. Only regular files under the command's own folder are read: a link anywhere on the way, a path that leaves the folder, or a folder that holds
// anything but files and folders makes the read throw (or the listing unknown), which is a refusal.
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { SEED_LOCK_LIMITS, seedLockHolds, type ProjectCommand, type SeedScriptLock, type SeedSourceReader } from "@agentx/contracts";

/** The checkout as the resolver reads it, rooted at the command's folder (`rootPath` + the command's `cwd`). */
export function checkoutSeedReader(rootPath: string, cwd: string): SeedSourceReader {
  const base = resolve(rootPath, cwd);
  const inside = (path: string): string => {
    const full = resolve(base, path);
    if (full !== base && !full.startsWith(`${base}${sep}`)) throw new Error("outside the command's folder");
    return full;
  };
  /** Every part from the command's folder down to the path must be a real folder or file, never a link (the workspace root above it is the worker's own). */
  const noLinks = async (full: string): Promise<boolean> => {
    let at = full;
    while (at.length >= base.length) {
      const info = await lstat(at).catch((error: unknown) => { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; });
      if (info === undefined) return false;
      if (info.isSymbolicLink()) throw new Error("a link");
      if (at === base) break;
      at = resolve(at, "..");
    }
    return true;
  };
  return {
    async read(path) {
      const full = inside(path);
      if (!await noLinks(full)) return undefined;
      const info = await lstat(full);
      if (!info.isFile()) return info.isDirectory() ? undefined : Promise.reject(new Error("not a regular file"));
      if (info.size > SEED_LOCK_LIMITS.fileBytes) throw new Error("too large");
      return readFile(full, "utf8");
    },
    async list(folder) {
      const full = inside(folder);
      if (!await noLinks(full)) return [];
      const found: string[] = [];
      const walk = async (directory: string): Promise<boolean> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { if (!await walk(path)) return false; continue; }
          if (!entry.isFile()) return false;
          found.push(relative(base, path).split(sep).join("/"));
          if (found.length > SEED_LOCK_LIMITS.files) return false;
        }
        return true;
      };
      return await walk(full) ? found : undefined;
    },
  };
}

/** Whether the seed command's lock still holds in the checkout. Never throws: any failure is false. */
export async function seedLockHoldsInCheckout(rootPath: string, command: ProjectCommand, lock: SeedScriptLock): Promise<boolean> {
  try {
    return await seedLockHolds(command, lock, checkoutSeedReader(rootPath, command.cwd));
  } catch {
    return false;
  }
}
