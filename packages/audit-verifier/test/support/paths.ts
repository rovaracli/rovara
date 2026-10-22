import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root: the nearest directory above this file whose package.json is this package's. */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { name?: string }).name === "@rovara/audit-verifier") return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("the package root was not found");
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot();
export const packageFile = (...parts: string[]): string => join(PACKAGE_ROOT, ...parts);
