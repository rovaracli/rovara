// Gate: the secret scan of the Cloud tree being released (BETA-CLOUD-PLAN section 4: Cloud tree gets gitleaks; the Code tree's port-guard stays in the Code pipeline).
// Scans exactly the files git tracks at the release commit (a clean export), so node_modules and build output never count. Findings are redacted.
// The scan is the WHOLE tree, with the config of the PIPELINE tree (`.gitleaks.toml`, passed with --config: a candidate's own gitleaks config is never read). That config is gitleaks'
// default rules and no allow entries: the gate refuses to run if it holds anything else (title, [extend], useDefault = true are the only lines). The three ways a candidate could still
// switch findings off are closed here: an inline `gitleaks:allow` comment (--ignore-gitleaks-allow), a tracked `.gitleaksignore` anywhere in the tree (the gate FAILS on one, and -i points
// at an empty directory), and a `.gitattributes` export-ignore that drops files from `git archive` (the exported file list must equal `git ls-tree -r HEAD` exactly).
// A fourth way is the default config's own path allowlist (gitleaks 8.30.1): it skips every file under a `node_modules/`, any path containing `gitleaks.toml`, `.svg`, `.png`/`.jpg`/..., fonts,
// `.pdf`/office files, and lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, ...). A rule added to the config cannot lift it (an extended config keeps the base allowlist: checked),
// so the gate closes it itself: (a) it FAILS on a tracked `node_modules/` directory or a gitleaks config other than the root `.gitleaks.toml`; (b) after the normal scan it scans a second copy of
// every tracked file under a neutral name (00001.txt, ...), so no path rule applies and the text of an svg, a lock file or a wrapper script is read like any source file. Image, font and PDF
// binaries are scanned the same way. gitleaks also skips a file by its FIRST BYTES, whatever its name (any application/* sniff: %PDF, PK\x03\x04 zip, gzip, ELF), so each copy starts with one
// newline: no magic number sits at offset 0 and the file is read as text (the reported line is one less). Compressed data inside is still unreadable to any regex scanner.
import type { Gate, GateInput, GateOutcome } from "../types.ts";

const ROOT_CONFIG = ".gitleaks.toml";
const ALLOWED_CONFIG_LINE = [/^title\s*=\s*"[^"]*"$/u, /^\[extend\]$/u, /^useDefault\s*=\s*true$/u];
/** The lines of the config that are not comments, blanks or one of the three allowed; empty means the config has no allow entry of any kind. */
export function configExtras(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !ALLOWED_CONFIG_LINE.some((rule) => rule.test(line)));
}

/**
 * The second-scan copy, run with node (always on the build machine; a shell loop over every file was five times slower). Args: tree, output dir, map file, archive list file.
 * Every regular file of the exported tree, and the TARGET TEXT of every symlink (gitleaks does not follow links and never reads their text), is written to `<output>/NNNNN.txt` with ONE newline before its bytes: gitleaks drops a file by its first bytes (a %PDF, zip, gzip, ELF magic
 * number), so nothing may start the copy. The map file says which tracked path each name stands for. A file that starts like an archive (found by content, not by name) is listed in the
 * archive file, for the gate to refuse.
 */
export const COPY_SCRIPT = `
const fs = require("node:fs");
const [tree, out, mapFile, archiveFile] = process.argv.slice(1);
const ARCHIVE_MAGIC = ["504b0304", "504b0506", "504b0708", "1f8b", "377abcaf271c", "425a68", "fd377a585a00", "28b52ffd", "526172211a07"];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = dir + "/" + entry.name;
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
  }
})(tree);
const map = [];
const archives = [];
files.forEach((full, index) => {
  const rel = full.slice(tree.length + 1);
  const name = String(index + 1).padStart(5, "0") + ".txt";
  const link = fs.lstatSync(full).isSymbolicLink();
  const body = link ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
  const head = body.subarray(0, 6).toString("hex");
  if (!link && (ARCHIVE_MAGIC.some((magic) => head.startsWith(magic)) || (body.length >= 262 && body.toString("latin1", 257, 262) === "ustar"))) archives.push(rel);
  fs.writeFileSync(out + "/" + name, Buffer.concat([Buffer.from("\\n"), body]));
  map.push(name + "\\t" + rel.replace(/[\\t\\r\\n]/g, " "));
});
fs.writeFileSync(mapFile, map.map((line) => line + "\\n").join(""));
fs.writeFileSync(archiveFile, archives.map((line) => line + "\\n").join(""));
`;

const WORK_DIR_SKIPPED = /(?:^|\/)node_modules(?:\/|$)|gitleaks\.toml|(?:^|\/)vendor(?:\/|$)/iu;

/** What the gate writes under its work directory: the exported tree, the empty ignore directory, the neutral-name copy, its map, the second report and the archive list. All are removed at the end. */
export const WORK_NAMES = ["gitleaks-tree", "gitleaks-no-ignore", "gitleaks-as-text", "gitleaks-as-text-map.tsv", "gitleaks-as-text-report.json", "gitleaks-archives.txt"] as const;

export const gate: Gate = {
  name: "gitleaks",
  phases: ["preflight"],
  // The copies of the candidate tree, the map and the report are removed whatever the verdict (a pass, a failure, a throw), so no second copy of the release tree stays on the build host.
  async run(input) {
    try { return await scan(input); } finally { await Promise.resolve(input.ports.exec("rm", ["-rf", ...WORK_NAMES.map((name) => `${input.dirs.work}/${name}`)])).catch(() => undefined); }
  },
};

async function scan(input: GateInput): Promise<GateOutcome> {
    const cloud = input.dirs.cloud;
    if (cloud === null) return { result: "fail", failures: ["no candidate tree to scan"] };
    // gitleaks skips a scan root whose own path holds an allowlisted part (checked: a work directory under node_modules/ scans nothing): refuse such a work directory outright.
    if (WORK_DIR_SKIPPED.test(input.dirs.work)) return { result: "fail", failures: [`the work directory ${input.dirs.work} has node_modules, vendor or gitleaks.toml in its path: gitleaks' default config would skip everything scanned under it`] };
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
    // The default config skips these paths whatever the file holds: refuse them rather than rely on the second scan alone (a tracked node_modules is never wanted, a nested config never read).
    const structural: string[] = [];
    const nodeModules = trackedFiles.filter((f) => f.split("/").some((part) => part.toLowerCase() === "node_modules"));
    if (nodeModules.length > 0) structural.push(`the tree tracks ${nodeModules.length} file(s) under node_modules/ (${nodeModules.slice(0, 3).join(", ")}): gitleaks' default config skips that whole directory, and installed packages are never committed`);
    const nestedConfigs = trackedFiles.filter((f) => f !== ROOT_CONFIG && /gitleaks\.toml/iu.test(f));
    if (nestedConfigs.length > 0) structural.push(`the tree tracks a gitleaks config other than the root ${ROOT_CONFIG} (${nestedConfigs.slice(0, 3).join(", ")}): the default config skips any path containing gitleaks.toml, and the gate reads only the pipeline's config`);
    if (structural.length > 0) return { result: "fail", failures: structural };
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
    // The second scan: every tracked file again, under a neutral name, so gitleaks' default path allowlist (svg, lock files, ...) cannot skip it. The config is the same; the map file
    // names which tracked path each neutral name stands for, and the report is turned back into rule, path and line (never a value: --redact).
    const asText = `${input.dirs.work}/gitleaks-as-text`;
    const map = `${input.dirs.work}/gitleaks-as-text-map.tsv`;
    const report = `${input.dirs.work}/gitleaks-as-text-report.json`;
    const archives = `${input.dirs.work}/gitleaks-archives.txt`;
    const copied = await input.ports.exec("node", ["-e", COPY_SCRIPT, tree, asText, map, archives]);
    if (copied.code !== 0) return { result: "fail", failures: [`could not copy the tree for the second (plain text) scan: ${copied.stderr.trim().slice(-200)}`] };
    // An archive (zip, gzip, 7z, bzip2, xz, zstd, rar, tar, found by its first bytes, not its name; a .docx, .xlsx or .jar is a zip) is refused. gitleaks' --max-archive-depth would open it
    // only if its magic number stays at offset 0, which the leading newline above prevents on purpose, and compressed members are not reliably read either: fail closed.
    const archiveList = input.ports.fs.exists(archives) ? input.ports.fs.readText(archives).split("\n").filter((f) => f !== "") : [];
    if (archiveList.length > 0) return { result: "fail", failures: [`the tree tracks ${archiveList.length} archive file(s) by content (${archiveList.slice(0, 3).join(", ")}): gitleaks does not open archives, so a value inside would never be scanned; archives are not committed`] };
    const second = await input.ports.exec("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--ignore-gitleaks-allow", "--config", config, "-i", emptyIgnoreDir, "--report-format", "json", "--report-path", report, asText]);
    if (second.code === 127) return { result: "fail", failures: ["gitleaks is not installed on this build machine"] };
    if (second.code !== 0) {
      const found = input.ports.fs.exists(report) ? describeFindings(input.ports.fs.readText(report), input.ports.fs.exists(map) ? input.ports.fs.readText(map) : "") : [];
      for (const line of found) input.log(line);
      return { result: "fail", failures: [`gitleaks found something or failed (exit ${second.code}) in the second scan, which reads every tracked file as plain text so no default path skip (svg, lock files, ...) applies: ${found.slice(0, 5).join("; ") || (second.stderr || second.stdout).split("\n").filter((l) => /leaks? found|error/iu.test(l)).slice(-3).join(" / ") || "see the build log"}`] };
    }
    return { result: "pass" };
}

/** "rule path:line" for each finding of the second scan, the neutral name turned back into the tracked path. Never a value. The copy has one leading newline, so the line is the report's minus one. */
export function describeFindings(reportText: string, mapText: string): string[] {
  const paths = new Map<string, string>();
  for (const line of mapText.split("\n")) { const [name, ...rest] = line.split("\t"); if (name !== undefined && rest.length > 0) paths.set(name, rest.join("\t")); }
  let rows: unknown;
  try { rows = JSON.parse(reportText); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const r = row as { RuleID?: unknown; File?: unknown; StartLine?: unknown };
    const name = typeof r.File === "string" ? r.File.split("/").pop() ?? "" : "";
    return `${typeof r.RuleID === "string" ? r.RuleID : "?"} ${paths.get(name) ?? name}:${typeof r.StartLine === "number" ? Math.max(1, r.StartLine - 1) : "?"}`;
  });
}
