import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** What CDK names an assembly directory when an App is built without an outdir (mkdtemp "cdk.out"). */
export const CDK_OUT_PREFIX = "cdk.out";

/** Removes the cdk.out* entries directly inside directory, and nothing else; returns the names it removed. */
export function removeCdkAssemblies(directory: string): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(CDK_OUT_PREFIX)) continue;
    rmSync(join(directory, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
