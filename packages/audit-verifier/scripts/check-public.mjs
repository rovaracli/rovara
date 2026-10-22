#!/usr/bin/env node
/**
 * check-public.mjs <dir> [--built]
 *
 * Checks that a directory holds nothing private, so it is safe to copy into a public repository.
 * Exit 0: clean. 1: at least one problem (each printed as `file:line: rule`, line 0 for a whole file; the
 * matched text is never printed, so a leaked value does not reach a log). 2: usage error.
 *
 * With --built, `dist/` must exist, and every file in it is also loaded with node from a copy that has no
 * node_modules, through a resolve hook that fails any import that is not a `node:` module or a relative file.
 * That load is the real import check; the patterns below are a fast first pass in front of it.
 *
 * Rules:
 *   file-type     a file type outside the allowlist, a symlink-free tree of text sources only
 *   symlink       a symlink anywhere (it is never followed)
 *   name          a file or directory name outside letters, digits and . _ @ -
 *   import        an import of anything but a `node:` module or a file inside the directory, in any form
 *                 (also computed imports, require, module creation, module declarations, type references)
 *   deps          a dependency field, a dependency that is not a build tool, or an install script
 *   json          a package.json that does not parse
 *   load          (--built) a dist file that does not load alone, or no dist at all
 *   private-name  a private product, repository or company name
 *   preprod       the word for a pre-production environment
 *   account-id    a 12-digit AWS account id, in digits, with dashes or spaces, or inside a longer run
 *   aws-host      a host in an Amazon Web Services service domain (documentation hosts excepted)
 *   cell-host     any host in the product's own domain (cells are named by subdomain)
 *   org-id        `org_` followed by 20 or more letters or digits
 *   pem           a private key, or base64 that is a certificate or a large blob and is not a pinned public root
 *
 * Words are matched after the text is normalised (case, compatibility forms such as fullwidth letters,
 * zero-width characters and \u escapes) and with a hyphen, underscore or space allowed between the parts of a
 * name. The checker is a tripwire against accidents, not a defence against someone who means to hide a word.
 *
 * This file builds its forbidden words from fragments, so it holds none of them itself and can be
 * checked by its own rules and copied to a public repository.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SEP = "[ \\t_-]*";
const NAME_RULES = [
  { rule: "private-name", parts: ["agent", "x"] },
  { rule: "private-name", parts: ["rovara", "cloud"] },
  { rule: "private-name", parts: ["prep", "labs"] },
  { rule: "preprod", parts: ["stag", "ing"] },
].map(({ rule, parts }) => ({ rule, regex: new RegExp(parts.join(SEP), "i") }));

// SHA-256 of the DER of the two pinned public roots (DigiCert Trusted Root G4, Sectigo Public Time Stamping
// Root R46), the same values as the fingerprints in the headers of src/trust/*.pem.
const PINNED_ROOTS = new Set([
  "552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988",
  "4941b001b8a97e961b7817c9d9e960ec4b056bfc915a8c1aabf6ef6b3ac046a5",
]);
// Test data that is base64 by nature: real time-stamp responses from the two public authorities, kept as
// they were issued. A file is let through the base64 rule only while its bytes still hash to this value.
const PINNED_FIXTURES = new Map([["test/support/real-timestamp-responses.ts", "74da6bd057039080f08cb6610f00b7902f58013a6ae53382ae427db7f7e1e414"]]);

const OWNER = join2("Prep", "Labs");
const COPYRIGHT_LINE = `Copyright 2026 ${OWNER}`;
const REPOSITORY_URL = join2("git+https://github.com/", OWNER, "AI/rovara-audit-verifier.git");

const DOC_HOSTS = new Set(["awsdocs.s3.amazonaws.com"]);
const PUBLIC_SITES = new Set(); // hosts of the product's own domain that may be named; none today
const AWS_HOST = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:amazonaws\.com|on\.aws|amazoncognito\.com|cloudfront\.net|awsapps\.com)(?![a-z0-9-])/gi;
const CELL_HOST = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*rovara\.dev(?![a-z0-9-])/gi;

// Root entries that are build output or tooling, skipped when they are real directories or files.
const SKIP_AT_ROOT = new Set(["node_modules", ".git", ".test-build", "tsconfig.tsbuildinfo"]);
const ROOT_FILES = new Set(["LICENSE", "NOTICE", ".gitignore"]);
const TEXT_EXTENSIONS = [".js", ".mjs", ".ts", ".json", ".md"];
const CODE_EXTENSIONS = [".js", ".mjs", ".ts"];
const BUILD_TOOLS = new Set(["typescript", "@types/node"]);
const NAME_CHARS = /^[A-Za-z0-9._@-]+$/;

class UsageError extends Error {}

function join2(...parts) {
  return parts.join("");
}

// ---- files ----

function walk(root, problems) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      const add = (rule) => problems.push({ rel, line: 0, rule });
      if (entry.isSymbolicLink()) add("symlink");
      else if (SKIP_AT_ROOT.has(rel) && (entry.isDirectory() || entry.isFile())) continue;
      else if (entry.isDirectory()) {
        nameProblems(rel, problems);
        visit(abs);
      } else if (entry.isFile()) {
        nameProblems(rel, problems);
        if (!allowedType(rel)) add("file-type");
        files.push({ abs, rel });
      } else add("file-type");
    }
  };
  visit(root);
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function nameProblems(rel, problems) {
  const name = rel.split("/").pop();
  if (!NAME_CHARS.test(name)) problems.push({ rel, line: 0, rule: "name" });
  const normal = normalise(rel);
  for (const { rule, regex } of NAME_RULES) if (regex.test(normal)) problems.push({ rel, line: 0, rule });
}

function allowedType(rel) {
  const name = rel.split("/").pop();
  if (!rel.includes("/") && ROOT_FILES.has(name)) return true;
  if (rel.startsWith("dist/")) return name.endsWith(".js") || name.endsWith(".d.ts");
  if (rel.startsWith("src/trust/") && name.endsWith(".pem")) return true;
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length);
}

function readText(file) {
  const bytes = readFileSync(file);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return bytes.toString("utf8");
}

// ---- text ----

function normalise(text) {
  const decoded = text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_all, a, b, c) => {
    const code = Number.parseInt(a ?? b ?? c, 16);
    return code < 0x20 || code > 0x10ffff ? " " : String.fromCodePoint(code);
  });
  return decoded.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function lineRules(raw, add, inTests) {
  const line = normalise(raw);
  for (const { rule, regex } of NAME_RULES) if (regex.test(line)) add(rule);
  for (const m of line.matchAll(AWS_HOST)) if (!DOC_HOSTS.has(m[0].toLowerCase())) add("aws-host");
  for (const m of line.matchAll(CELL_HOST)) if (!PUBLIC_SITES.has(m[0].toLowerCase())) add("cell-host");
  if (/org_[a-z0-9]{20}/i.test(line)) add("org-id");
  // Bare digit runs are checked everywhere but in the tests, whose data is full of numbers and hex that are not ids.
  if (!inTests) for (const m of line.matchAll(/[A-Za-z0-9]+/g)) if (m[0].length < 32 && /[0-9]{12}/.test(m[0])) add("account-id");
  if (/::[0-9]{12}:/.test(line) || /account[^0-9\n]{0,24}[0-9]{12}/i.test(line)) add("account-id");
  if (/(?<![0-9])[0-9]{4}[- ][0-9]{4}[- ][0-9]{4}(?![0-9])/.test(line)) add("account-id");
  if (/(?<![0-9])[0-9]{3}([- ])[0-9]{3}\1[0-9]{3}\1[0-9]{3}(?![0-9])/.test(line)) add("account-id");
  if (/(?<![0-9])[0-9]{6}[- ][0-9]{6}(?![0-9])/.test(line)) add("account-id");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(line)) add("pem");
}

// ---- imports ----

const CREATE_MODULE_REQUIRE = new RegExp(`\\b${join2("create", "Require")}\\b`, "g");

function specifierAllowed(spec, file, root) {
  if (spec.startsWith("node:")) return true;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = resolve(dirname(file), spec);
    return target === root || target.startsWith(root + sep);
  }
  return false;
}

/** Indexes of imports that are not allowed, found by pattern. The load check is the one that settles it. */
function importProblems(text, file, root) {
  const bad = [];
  const literal = (arg) => /^\s*(["'])([^"'`\n]*)\1\s*(?:,[\s\S]*)?$/.exec(arg);
  for (const m of text.matchAll(/\b(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])([^"'\n]*)\1/g)) {
    if (!specifierAllowed(m[2], file, root)) bad.push(m.index);
  }
  for (const m of text.matchAll(/\bimport\s*(["'])([^"'\n]*)\1/g)) {
    if (!specifierAllowed(m[2], file, root)) bad.push(m.index);
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    const lit = literal(m[1]);
    if (lit === null || !specifierAllowed(lit[2], file, root)) bad.push(m.index);
  }
  for (const m of text.matchAll(CREATE_MODULE_REQUIRE)) bad.push(m.index);
  for (const m of text.matchAll(/\bdeclare\s+module\s+["'`]/g)) bad.push(m.index);
  for (const m of text.matchAll(/\/\/\/\s*<reference\s+(types|path|lib)\s*=\s*(["'])([^"']*)\2/g)) {
    if (!(m[1] === "types" && m[3] === "node")) bad.push(m.index);
  }
  return bad;
}

// ---- base64 blobs and certificates ----

function isDer(bytes) {
  if (bytes.length < 32 || bytes[0] !== 0x30) return false;
  const first = bytes[1];
  if (first < 0x80) return 2 + first === bytes.length;
  const count = first & 0x7f;
  if (count === 0 || count > 4) return false;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + bytes[2 + i];
  return 2 + count + length === bytes.length;
}

/**
 * Lines of the text, each split further at escaped line breaks, so base64 that sits in a string with \n escapes,
 * behind comment stars or slashes, or between concatenated strings is read as the lines it was cut from.
 * Returns the line numbers (1-based) of base64 that is a certificate or a blob and not a pinned root.
 */
function blobProblems(text) {
  const bad = [];
  let run = [];
  let startLine = 0;
  const flush = () => {
    if (run.length > 0) {
      const base64 = run.join("");
      const bytes = Buffer.from(base64, "base64");
      const pinned = PINNED_ROOTS.has(createHash("sha256").update(bytes).digest("hex"));
      // Random bytes in base64 are about one character in six a digit and mostly not hex; a list of identifiers
      // is neither, and a list of hashes is all hex.
      const digits = base64.replace(/[^0-9]/g, "").length;
      const hex = base64.replace(/[^0-9a-fA-F]/g, "").length;
      const blob = base64.length >= 200 && digits * 12 >= base64.length && hex * 5 < base64.length * 4;
      if (!pinned && (isDer(bytes) || blob)) bad.push(startLine);
    }
    run = [];
  };
  const add = (piece, index) => {
    if (run.length === 0) startLine = index + 1;
    run.push(piece);
  };
  text.split("\n").forEach((line, index) => {
    for (const part of line.split(/\\[nrt]|\\u000[aAdD]|\\x0[aAdD]/)) {
      if (part.includes("-----BEGIN")) flush();
      // The base64 of a line, without the comment marks, quotes, commas or concatenation signs around it.
      const core = part
        .trim()
        .replace(/^(?:\/\/+|\/\*+|\*+|#+)\s*/, "")
        .replace(/^[("'`\s]+/, "")
        .replace(/(?:["'`]\s*\+|["'`])?\s*[,;)]*\s*$/, "");
      const long = [...part.matchAll(/[A-Za-z0-9+/]{100,}={0,2}/g)];
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(core) && (core.length >= 16 || (run.length > 0 && core.length >= 2))) add(core, index);
      else if (long.length === 1) add(long[0][0], index);
      else if (/[A-Za-z0-9+/]{16,}/.test(part)) flush();
      // Anything else holds no base64: text, a marker or a blank line, and the block goes on.
      if (part.includes("-----END")) flush();
    }
  });
  flush();
  return bad;
}

// ---- package.json ----

function packageJsonProblems(text, add) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    add(0, "json");
    return undefined;
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
    if (pkg[field] !== undefined) add(0, "deps");
  }
  for (const name of Object.keys(pkg.devDependencies ?? {})) if (!BUILD_TOOLS.has(name)) add(0, "deps");
  for (const hook of ["preinstall", "install", "postinstall"]) if (pkg.scripts?.[hook] !== undefined) add(0, "deps");
  if (pkg.repository?.url === REPOSITORY_URL) pkg.repository.url = "";
  return pkg;
}

// ---- the built package, loaded alone ----

const HOOKS = `
let entry;
export function initialize(data) { entry = data.entry; }
export async function resolve(specifier, context, next) {
  if (specifier === entry || specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../")) return next(specifier, context);
  throw new Error("import outside node: and the package");
}
`;
// Loads the one file named in the environment (written in two pieces so the checker's own text holds no computed import).
const DRIVER = join2("await imp", "ort(process.env.CHECK_PUBLIC_ENTRY);");
const REGISTER = `
import { register } from "node:module";
register("./hooks.mjs", import.meta.url, { data: { entry: process.env.CHECK_PUBLIC_ENTRY } });
`;

function loadProblems(root, problems) {
  const dist = join(root, "dist");
  if (!existsSync(dist)) {
    problems.push({ rel: "dist", line: 0, rule: "load" });
    return;
  }
  const temp = mkdtempSync(join(tmpdir(), "check-public-load-"));
  try {
    const loader = join(temp, "loader");
    const copy = join(temp, "package");
    mkdirSync(loader);
    mkdirSync(copy);
    writeFileSync(join(loader, "hooks.mjs"), HOOKS);
    writeFileSync(join(loader, "register.mjs"), REGISTER);
    cpSync(dist, join(copy, "dist"), { recursive: true });
    if (existsSync(join(root, "package.json"))) cpSync(join(root, "package.json"), join(copy, "package.json"));
    const entries = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(join(dir, entry.name));
        else if (entry.name.endsWith(".js")) entries.push(join(dir, entry.name));
      }
    };
    collect(join(copy, "dist"));
    for (const entry of entries.sort()) {
      const url = pathToFileURL(entry).href;
      const result = spawnSync(
        process.execPath,
        [join2("--imp", "ort"), pathToFileURL(join(loader, "register.mjs")).href, "--input-type=module", "-e", DRIVER],
        { cwd: copy, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", CHECK_PUBLIC_ENTRY: url } },
      );
      if (result.status !== 0) problems.push({ rel: relative(copy, entry).split(sep).join("/"), line: 0, rule: "load" });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ---- the check ----

function checkDirectory(rootArg, built) {
  let root;
  try {
    root = resolve(rootArg);
    readdirSync(root);
  } catch {
    throw new UsageError("the first argument must be a readable directory");
  }
  const problems = [];
  const files = walk(root, problems);
  for (const { abs, rel } of files) {
    const add = (line, rule) => problems.push({ rel, line, rule });
    const bytes = readFileSync(abs);
    const sha = createHash("sha256").update(bytes).digest("hex");
    let text = readText(abs);
    if (text.includes("\u0000")) {
      add(0, "file-type");
      continue;
    }
    const atRoot = !rel.includes("/");

    let scanned = text;
    if (atRoot && rel === "package.json") {
      const pkg = packageJsonProblems(text, add);
      if (pkg !== undefined) scanned = JSON.stringify(pkg, null, 2);
    }
    if (atRoot && (rel === "LICENSE" || rel === "NOTICE")) {
      scanned = scanned.split("\n").map((line) => (line === COPYRIGHT_LINE ? "" : line)).join("\n");
    }

    if (CODE_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
      for (const index of importProblems(text, abs, root)) add(text.slice(0, index).split("\n").length, "import");
    }
    if (PINNED_FIXTURES.get(rel) !== sha) {
      for (const line of blobProblems(text)) add(line, "pem");
    }
    scanned.split("\n").forEach((raw, index) => lineRules(raw, (rule) => add(index + 1, rule), rel.startsWith("test/")));
  }
  if (built) loadProblems(root, problems);
  const seen = new Set();
  return problems.filter((p) => {
    const key = `${p.rel}:${p.line}:${p.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main(argv) {
  const built = argv.includes("--built");
  const rest = argv.filter((arg) => arg !== "--built");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    process.stderr.write("usage: check-public.mjs <dir> [--built]\n");
    return 2;
  }
  let problems;
  try {
    problems = checkDirectory(rest[0], built);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`check-public: ${error.message}\n`);
    return 2;
  }
  if (problems.length === 0) {
    process.stdout.write("check-public: ok, nothing private found\n");
    return 0;
  }
  for (const { rel, line, rule } of problems) process.stderr.write(`${rel}:${line}: ${rule}\n`);
  process.stderr.write(`check-public: ${problems.length} problem(s)\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
