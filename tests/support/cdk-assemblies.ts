import { basename } from "node:path";
import { rmSync } from "node:fs";

/** What CDK names an assembly directory when an App is built without an outdir (it calls mkdtempSync on "<tmpdir>/cdk.out"). */
export const CDK_OUT_PREFIX = "cdk.out";

/** The part of node:fs the tracker wraps. */
export interface MkdtempFs {
  mkdtempSync: (prefix: string, ...rest: never[]) => string;
}

/**
 * Starts recording every cdk.out* directory this process creates through fs.mkdtempSync (aws-cdk-lib's FileSystem.mkdtemp, for an App built without an outdir).
 * `finish` puts mkdtempSync back and removes exactly those directories: never one made by another process or another test worker.
 */
export function trackCdkAssemblies(fs: MkdtempFs, remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })): { finish: () => string[] } {
  const original = fs.mkdtempSync;
  const made: string[] = [];
  fs.mkdtempSync = ((prefix: string, ...rest: never[]) => {
    const created = original.call(fs, prefix, ...rest);
    if (typeof created === "string" && basename(created).startsWith(CDK_OUT_PREFIX)) made.push(created);
    return created;
  });
  return {
    finish: () => {
      fs.mkdtempSync = original;
      for (const path of made) remove(path);
      return made;
    },
  };
}
