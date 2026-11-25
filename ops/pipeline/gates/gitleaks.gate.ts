// Gate: the secret scan of the Cloud tree being released (BETA-CLOUD-PLAN section 4: Cloud tree gets gitleaks; the Code tree's port-guard stays in the Code pipeline).
// Scans exactly the files git tracks at the release commit (a clean export), so node_modules and build output never count. Findings are redacted.
// The scan is the WHOLE tree, with the config of the PIPELINE tree (`.gitleaks.toml`, passed with --config: a candidate's own gitleaks config is never read). That config is gitleaks'
// default rules and no allow entries: the gate refuses to run if it holds anything else (title, [extend], useDefault = true are the only lines). The three ways a candidate could still
// switch findings off are closed here: an inline `gitleaks:allow` comment (--ignore-gitleaks-allow), a tracked `.gitleaksignore` anywhere in the tree (the gate FAILS on one, and -i points
// at an empty directory), and a `.gitattributes` export-ignore that drops files from `git archive` (the exported file list must equal `git ls-tree -r HEAD` exactly).
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
    const emptyIgnoreDir = `${input.dirs.work}/gitleaks-no-ignore`;
    const tracked = await input.ports.exec("git", ["-C", cloud, "ls-tree", "-r", "-z", "--name-only", "HEAD"]);
    if (tracked.code !== 0) return { result: "fail", failures: [`could not list the tracked files: ${tracked.stderr.trim().slice(-200)}`] };
    const trackedFiles = tracked.stdout.split("\0").filter((f) => f !== "");
    const ignoreFiles = trackedFiles.filter((f) => f.split("/").pop() === ".gitleaksignore");
    if (ignoreFiles.length > 0) return { result: "fail", failures: [`the tree tracks a .gitleaksignore (${ignoreFiles.slice(0, 3).join(", ")}): it would switch findings off, and no ignore file is allowed`] };
    const exported = await input.ports.exec("bash", ["-c", 'rm -rf "$1" "$3" && mkdir -p "$1" "$3" && git -C "$2" archive HEAD | tar -x -C "$1"', "export", tree, cloud, emptyIgnoreDir]);
    if (exported.code !== 0) return { result: "fail", failures: [`could not export the tree to scan: ${exported.stderr.trim().slice(-200)}`] };
    const listed = await input.ports.exec("bash", ["-c", 'cd "$1" && find . \\( -type f -o -type l \\) -print0', "list", tree]);
    if (listed.code !== 0) return { result: "fail", failures: [`could not list the exported files: ${listed.stderr.trim().slice(-200)}`] };
    const exportedFiles = new Set(listed.stdout.split("\0").filter((f) => f !== "").map((f) => f.replace(/^\.\//u, "")));
    const missing = trackedFiles.filter((f) => !exportedFiles.has(f));
    const trackedSet = new Set(trackedFiles);
    const extra = [...exportedFiles].filter((f) => !trackedSet.has(f));
    if (missing.length > 0 || extra.length > 0) return { result: "fail", failures: [`the exported tree is not the tracked tree (${missing.length} tracked file(s) missing from the export, e.g. through .gitattributes export-ignore, and ${extra.length} extra): ${[...missing, ...extra].slice(0, 3).join(", ")}; the scan would not see all of it`] };
    const scan = await input.ports.exec("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--ignore-gitleaks-allow", "--config", config, "-i", emptyIgnoreDir, tree]);
    if (scan.code === 127) return { result: "fail", failures: ["gitleaks is not installed on this build machine"] };
    for (const line of `${scan.stdout}\n${scan.stderr}`.split("\n").filter((l) => l !== "").slice(-20)) input.log(line);
    if (scan.code !== 0) return { result: "fail", failures: [`gitleaks found something or failed (exit ${scan.code}): ${(scan.stderr || scan.stdout).split("\n").filter((l) => /leaks? found|error/iu.test(l)).slice(-3).join(" / ") || "see the redacted report in the build log"}`] };
    return { result: "pass" };
  },
};
