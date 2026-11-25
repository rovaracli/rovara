// Gate: the secret scan of the Cloud tree being released (BETA-CLOUD-PLAN section 4: Cloud tree gets gitleaks; the Code tree's port-guard stays in the Code pipeline).
// Scans exactly the files git tracks at the release commit (a clean export), so node_modules and build output never count. Findings are redacted.
// The scan is the WHOLE tree, with the config of the PIPELINE tree (`.gitleaks.toml`, passed with --config so a candidate's own config or ignore file can never loosen it). That config
// is gitleaks' default rules and no allow entries: the gate refuses to run if it holds anything else (title, [extend], useDefault = true are the only lines).
import type { Gate } from "../types.ts";

const ALLOWED_CONFIG_LINE = [/^title\s*=\s*"[^"]*"$/u, /^\[extend\]$/u, /^useDefault\s*=\s*true$/u];
/** The lines of the config that are not comments, blanks or one of the three allowed; empty means the config has no allow entry of any kind. */
export function configExtras(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !ALLOWED_CONFIG_LINE.some((rule) => rule.test(line)));
}

export const gate: Gate = {
  name: "gitleaks",
  phases: ["preflight"],
  async run(input) {
    const cloud = input.dirs.cloud;
    if (cloud === null) return { result: "fail", failures: ["no candidate tree to scan"] };
    const config = `${input.dirs.pipeline}/.gitleaks.toml`;
    if (!input.ports.fs.exists(config)) return { result: "fail", failures: [`the secret scan config ${config} is missing: the scan never runs on gitleaks' defaults by accident`] };
    const extras = configExtras(input.ports.fs.readText(config));
    if (extras.length > 0) return { result: "fail", failures: [`the secret scan config holds ${extras.length} line(s) other than title, [extend] and useDefault = true (no allowlist or rule change is allowed here; the controller changes this): ${extras[0]!.slice(0, 80)}`] };
    const tree = `${input.dirs.work}/gitleaks-tree`;
    const exported = await input.ports.exec("bash", ["-c", 'rm -rf "$1" && mkdir -p "$1" && git -C "$2" archive HEAD | tar -x -C "$1"', "export", tree, cloud]);
    if (exported.code !== 0) return { result: "fail", failures: [`could not export the tree to scan: ${exported.stderr.trim().slice(-200)}`] };
    const scan = await input.ports.exec("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--config", config, tree]);
    if (scan.code === 127) return { result: "fail", failures: ["gitleaks is not installed on this build machine"] };
    for (const line of `${scan.stdout}\n${scan.stderr}`.split("\n").filter((l) => l !== "").slice(-20)) input.log(line);
    if (scan.code !== 0) return { result: "fail", failures: [`gitleaks found something or failed (exit ${scan.code}): ${(scan.stderr || scan.stdout).split("\n").filter((l) => /leaks? found|error/iu.test(l)).slice(-3).join(" / ") || "see the redacted report in the build log"}`] };
    return { result: "pass" };
  },
};
