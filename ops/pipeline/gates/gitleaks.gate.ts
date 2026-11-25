// Gate: the secret scan of the Cloud tree being released (BETA-CLOUD-PLAN section 4: Cloud tree gets gitleaks; the Code tree's port-guard stays in the Code pipeline).
// Scans exactly the files git tracks at the release commit (a clean export), so node_modules and build output never count. Findings are redacted.
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "gitleaks",
  phases: ["preflight"],
  async run(input) {
    const cloud = input.dirs.cloud;
    if (cloud === null) return { result: "fail", failures: ["no candidate tree to scan"] };
    const tree = `${input.dirs.work}/gitleaks-tree`;
    const exported = await input.ports.exec("bash", ["-c", 'rm -rf "$1" && mkdir -p "$1" && git -C "$2" archive HEAD | tar -x -C "$1"', "export", tree, cloud]);
    if (exported.code !== 0) return { result: "fail", failures: [`could not export the tree to scan: ${exported.stderr.trim().slice(-200)}`] };
    const scan = await input.ports.exec("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", tree]);
    if (scan.code === 127) return { result: "fail", failures: ["gitleaks is not installed on this build machine"] };
    for (const line of `${scan.stdout}\n${scan.stderr}`.split("\n").filter((l) => l !== "").slice(-20)) input.log(line);
    if (scan.code !== 0) return { result: "fail", failures: [`gitleaks found something or failed (exit ${scan.code}): ${(scan.stderr || scan.stdout).split("\n").filter((l) => /leaks? found|error/iu.test(l)).slice(-3).join(" / ") || "see the redacted report in the build log"}`] };
    return { result: "pass" };
  },
};
