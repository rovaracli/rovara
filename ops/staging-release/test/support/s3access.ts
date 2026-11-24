// The runs-bucket reads a pack script made (from the fake CLI's call log), checked against s3-access.json: a read that is not in the file for that stage fails the test that ran the script.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACK } from "./harness.ts";

const EXEC_ID = "0123abcd-1111-4222-8333-444455556666";
const STAGE_OF_SCRIPT: Record<string, string> = {
  "preview.sh": "preview", "gates.sh": "gates", "guard.sh": "guard", "deploy.sh": "deploy", "postcheck.sh": "postcheck", "evaluator/decide.sh": "decide", "settings-record.sh": "deploy",
};
export const normKey = (k: string): string =>
  k.split(EXEC_ID).join("<exec>").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<prior-exec>").replace(/^ci-cache\/.*$/, "ci-cache/<key>.json");

/** Normalised runs-bucket keys read by `s3 cp` downloads in the call log; a recursive download is `<dir>/*`. */
export function readsOf(calls: string[]): string[] {
  const out: string[] = [];
  for (const line of calls) {
    if (!line.startsWith("s3 cp") || line.includes("cdk-hnb659fds-assets-")) continue;
    const parts = line.split(" ").filter((x) => !x.startsWith("--"));
    const last = parts[parts.length - 1] ?? "";
    if (parts.length < 4 || last.startsWith("s3://")) continue; // an upload
    for (const u of line.split(" ").filter((x) => x.startsWith("s3://"))) {
      const k = normKey(u.replace(/^s3:\/\/[^/]+\//, ""));
      out.push(line.includes("--recursive") ? `${k.replace(/\/?$/, "/")}*` : k);
    }
  }
  return out;
}

const covered = (read: string, allowed: string[]): boolean => allowed.some((a) => a === read || (a.endsWith("*") && read.startsWith(a.slice(0, -1))));

/** Throws when `script` read a path its stage's entry in s3-access.json does not list. */
export function assertS3Covered(script: string, calls: string[]): void {
  if (process.env.UPDATE_S3_ACCESS === "1") return; // regenerating the file
  const stage = STAGE_OF_SCRIPT[script];
  if (stage === undefined) return;
  let file: { stages: Record<string, { read: string[] }> };
  try { file = JSON.parse(readFileSync(join(PACK, "s3-access.json"), "utf8")) as typeof file; } catch { return; } // first generation
  const allowed = file.stages[stage]?.read ?? [];
  const missing = readsOf(calls).filter((r) => !covered(r, allowed));
  if (missing.length > 0) throw new Error(`${script} (stage ${stage}) read S3 path(s) that s3-access.json does not list: ${[...new Set(missing)].join(", ")}`);
}
