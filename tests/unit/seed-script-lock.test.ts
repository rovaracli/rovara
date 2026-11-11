// SEED-RISK-1: the seed script lock (contracts seed-script-lock.ts). What a seed command resolves to is defined and hashed the same way for the broker and the worker; anything the resolver does not understand is
// refused (the seed stays HIGH), and any change to what runs changes the hash.
import { describe, expect, it } from "vitest";
import { seedLockHolds, seedScriptLockOf, type SeedSourceReader } from "@rovara-code/contracts";

const cmd = (executable: string, args: string[], env?: Record<string, string>) => ({ cwd: "repo/web", executable, args, timeoutSeconds: 900, ...(env === undefined ? {} : { env }) });
/** A reader over an in-memory tree (paths relative to the command's folder; `above` are files in folders above it, up to the repository root). */
const tree = (files: Record<string, string>, fail?: string, above: readonly string[] = []): SeedSourceReader => ({
  async read(path) { if (path === fail) throw new Error("host error"); return files[path]; },
  async list(folder) { return Object.keys(files).filter((path) => path.startsWith(`${folder}/`)); },
  async anyAbove(paths) { if (fail === "above") throw new Error("host error"); return paths.some((path) => path in files || above.includes(path)); },
});
const pkg = (value: unknown) => JSON.stringify(value);
const NPM_SEED = { "package.json": pkg({ scripts: { seed: "node prisma/seed.js" } }), "prisma/seed.js": "const { PrismaClient } = require('@prisma/client');\n" };

describe("a seed command's lock", () => {
  it("locks `npm run seed` over the script body and the file it runs, and names both files", async () => {
    const resolved = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.lock.from).toEqual(["package.json", "prisma/seed.js"]);
    expect(resolved.lock.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when the seed file, the script body, the command or anything else in package.json changes (the whole package.json is hashed)", async () => {
    const base = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED));
    const file = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "prisma/seed.js": `${NPM_SEED["prisma/seed.js"]}// more\n` }));
    const body = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js extra" } }) }));
    const other = await seedScriptLockOf(cmd("yarn", ["run", "seed"]), tree(NPM_SEED));
    const version = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "package.json": pkg({ version: "2.0.0", scripts: { seed: "node prisma/seed.js" } }) }));
    const hashes = [base, file, body, other, version].map((item) => (item.ok ? item.lock.hash : "refused"));
    expect(new Set(hashes).size).toBe(5);
  });

  it("locks the tools' own seeds: prisma's `prisma.seed`, a knex seeds folder, sequelize seeders", async () => {
    const prisma = await seedScriptLockOf(cmd("npx", ["prisma", "db", "seed"]), tree({ "package.json": pkg({ prisma: { seed: "tsx prisma/seed.ts" } }), "prisma/seed.ts": "import { PrismaClient } from '@prisma/client';\n" }));
    expect(prisma.ok && prisma.lock.from).toEqual(["package.json", "prisma/seed.ts"]);
    const knex = await seedScriptLockOf(cmd("npx", ["knex", "seed:run"]), tree({ "knexfile.js": "module.exports = { client: 'pg' };\n", "seeds/01_users.js": "exports.seed = async (knex) => {};\n", "seeds/02_posts.js": "exports.seed = async () => {};\n" }));
    expect(knex.ok && knex.lock.from).toEqual(["knexfile.js", "seeds/01_users.js", "seeds/02_posts.js"]);
    const sequelize = await seedScriptLockOf(cmd("npx", ["sequelize-cli", "db:seed:all"]), tree({ "config/config.json": "{}", "seeders/2024-users.js": "module.exports = { up() {} };\n" }));
    expect(sequelize.ok && sequelize.lock.from).toEqual(["config/config.json", "seeders/2024-users.js"]);
  });

  it.each<readonly [string, ReturnType<typeof cmd>, Record<string, string>, string]>([
    ["its own variables", cmd("npm", ["run", "seed"], { NODE_OPTIONS: "--require ./x.js" }), NPM_SEED, "has_env"],
    ["a pre-script", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js", preseed: "node other.js" } }) }, "pre_post_script"],
    ["a shell line", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js && curl x" } }) }, "script_shape"],
    ["a node option before the file", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node --require ./x.js prisma/seed.js" } }) }, "script_shape"],
    ["a seed file that loads another repository file", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "const data = require('./data');\n" }, "imports_repo_files"],
    ["a missing script", cmd("npm", ["run", "nope"]), NPM_SEED, "not_a_repo_script"],
    ["a command that is not a script run", cmd("bash", ["-c", "node prisma/seed.js"]), NPM_SEED, "not_a_repo_script"],
    ["a package manager's own command", cmd("yarn", ["install"]), NPM_SEED, "manager_command"],
    ["a prisma config that can move the seed", cmd("npx", ["prisma", "db", "seed"]), { "package.json": pkg({ prisma: { seed: "node prisma/seed.js" } }), "prisma/seed.js": "x", "prisma.config.ts": "export default {}" }, "tool_config"],
    ["a knexfile that names its own seeds folder", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = { seeds: { directory: './other' } };", "seeds/a.js": "x" }, "tool_config"],
    ["an empty seeds folder", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = {};" }, "no_files"],
    ["a missing seed file", cmd("npm", ["run", "seed"]), { "package.json": NPM_SEED["package.json"] }, "unreadable"],
    // Review I2: the cheap gaps, each closed.
    [".npmrc beside it", cmd("npm", ["run", "seed"]), { ...NPM_SEED, ".npmrc": "script-shell=./x.sh" }, "manager_config"],
    [".yarnrc.yml beside it", cmd("yarn", ["seed"]), { ...NPM_SEED, ".yarnrc.yml": "yarnPath: ./x.cjs" }, "manager_config"],
    [".yarnrc beside it", cmd("yarn", ["run", "seed"]), { ...NPM_SEED, ".yarnrc": "yarn-path ./x.js" }, "manager_config"],
    ["bunfig.toml beside it", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "bunfig.toml": "preload = ['./x.ts']" }, "manager_config"],
    ["a .config/prisma.ts that can move the seed", cmd("npx", ["prisma", "db", "seed"]), { "package.json": pkg({ prisma: { seed: "node prisma/seed.js" } }), "prisma/seed.js": "x", ".config/prisma.ts": "export default {}" }, "tool_config"],
    ["pnpm's own deploy, even where a script is named deploy", cmd("pnpm", ["deploy"]), { ...NPM_SEED, "package.json": pkg({ scripts: { deploy: "node prisma/seed.js" } }) }, "manager_command"],
    ["yarn's own node", cmd("yarn", ["node"]), { ...NPM_SEED, "package.json": pkg({ scripts: { node: "node prisma/seed.js" } }) }, "manager_command"],
    ["a require by a computed path", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "require(path.join(__dirname, 'lib.js'));\n" }, "imports_repo_files"],
    ["createRequire", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "require('module').createRequire(__filename)('pg');\n" }, "imports_repo_files"],
    ["an import by a variable", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "const name = 'x'; await import(name);\n" }, "imports_repo_files"],
    ["a knexfile with a computed seeds key", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = { ['se' + 'eds']: { directory: './db/real' } };", "seeds/a.js": "x" }, "tool_config"],
    // Follow-up R1: text run as code, or a file loaded by reading it.
    ...[
      "eval(\"require('pg')\");",
      "const f = Function('return 1'); f();",
      "const f = new Function('return 1');",
      "const vm = require('vm'); vm.runInThisContext('1');",
      "const load = require; load.call(null, 'pg'); require.call(null, 'pg');",
      "require.apply(null, ['pg']);",
      "module.constructor._load('pg');",
      "const config = JSON.parse(readFileSync('db/config.json', 'utf8'));",
      "const config = JSON.parse(fs.readFileSync('db/config.json'));",
    ].map((text) => [`a seed file with ${text}`, cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": `${text}\n` }, "runs_text_as_code"] as const),
    ["a knexfile that loads its config by reading a file", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = JSON.parse(require('fs').readFileSync('db.json'));", "seeds/a.js": "x" }, "runs_text_as_code"],
    ["a knexfile with eval", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = eval('({ client: \"pg\" })');", "seeds/a.js": "x" }, "runs_text_as_code"],
    [".sequelizerc", cmd("npx", ["sequelize-cli", "db:seed:all"]), { ".sequelizerc": "module.exports = {}", "seeders/a.js": "x" }, "tool_config"],
    ["a prisma seed with shell syntax", cmd("npx", ["prisma", "db", "seed"]), { "package.json": pkg({ prisma: { seed: "node prisma/seed.js && curl x" } }), "prisma/seed.js": "x" }, "tool_config"],
    ["more than 32 seed files", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = {};", ...Object.fromEntries(Array.from({ length: 33 }, (_, at) => [`seeds/${String(at).padStart(2, "0")}.js`, "x"])) }, "too_large"],
    ["a file over 256 KiB", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "x".repeat(262_145) }, "too_large"],
    ["more than 1 MiB in all", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = {};", ...Object.fromEntries(Array.from({ length: 5 }, (_, at) => [`seeds/${String(at)}.js`, "x".repeat(250_000)])) }, "too_large"],
  ])("refuses %s", async (_name, command, files, refusal) => {
    expect(await seedScriptLockOf(command, tree(files))).toEqual({ ok: false, refusal });
  });

  it("refuses a settings file in a folder ABOVE the command's, up to the repository root", async () => {
    expect(await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED, undefined, [".npmrc"]))).toEqual({ ok: false, refusal: "manager_config" });
    expect(await seedScriptLockOf(cmd("npx", ["prisma", "db", "seed"]), tree({ "package.json": pkg({ prisma: { seed: "node prisma/seed.js" } }), "prisma/seed.js": "x" }, undefined, [".config/prisma.mts"]))).toEqual({ ok: false, refusal: "tool_config" });
    expect(await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED, "above"))).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("still locks plain package loads (a literal require or import of a package is code the task already runs)", async () => {
    const resolved = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "prisma/seed.js": "const pg = require('pg');\nconst { faker } = await import(\"@faker-js/faker\");\nimport type { X } from 'y';\nasync function main() { await prisma.user.createFunction(); evaluate(1); JSON.parse('{}'); }\nmain();\n" }));
    expect(resolved.ok).toBe(true);
  });

  it("refuses when the reader cannot answer (a host error is never a pass)", async () => {
    expect(await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED, "prisma/seed.js"))).toEqual({ ok: false, refusal: "unreadable" });
    expect(await seedScriptLockOf(cmd("npx", ["knex", "seed:run"]), { read: async (path) => (path === "knexfile.js" ? "module.exports = {};" : undefined), list: async () => undefined, anyAbove: async () => false })).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("holds only while the checkout resolves to the same hash", async () => {
    const resolved = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED));
    if (!resolved.ok) throw new Error("expected a lock");
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree(NPM_SEED))).toBe(true);
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree({ ...NPM_SEED, "prisma/seed.js": "process.exit(0)" }))).toBe(false);
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree(NPM_SEED, "prisma/seed.js"))).toBe(false);
  });
});
