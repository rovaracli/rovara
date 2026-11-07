// SEED-RISK-1: the seed script lock (contracts seed-script-lock.ts). What a seed command resolves to is defined and hashed the same way for the broker and the worker; anything the resolver does not understand is
// refused (the seed stays HIGH), and any change to what runs changes the hash.
import { describe, expect, it } from "vitest";
import { seedLockHolds, seedScriptLockOf, type SeedSourceReader } from "@agentx/contracts";

const cmd = (executable: string, args: string[], env?: Record<string, string>) => ({ cwd: "repo/web", executable, args, timeoutSeconds: 900, ...(env === undefined ? {} : { env }) });
/** A reader over an in-memory tree (paths relative to the command's folder). */
const tree = (files: Record<string, string>, fail?: string): SeedSourceReader => ({
  async read(path) { if (path === fail) throw new Error("host error"); return files[path]; },
  async list(folder) { return Object.keys(files).filter((path) => path.startsWith(`${folder}/`)); },
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

  it("changes when the seed file, the script body or the command changes (and not when the rest of package.json does)", async () => {
    const base = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED));
    const file = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "prisma/seed.js": `${NPM_SEED["prisma/seed.js"]}// more\n` }));
    const body = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js extra" } }) }));
    const other = await seedScriptLockOf(cmd("yarn", ["run", "seed"]), tree(NPM_SEED));
    const version = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree({ ...NPM_SEED, "package.json": pkg({ version: "2.0.0", scripts: { seed: "node prisma/seed.js" } }) }));
    const hashes = [base, file, body, other].map((item) => (item.ok ? item.lock.hash : "refused"));
    expect(new Set(hashes).size).toBe(4);
    expect(version.ok && base.ok && version.lock.hash === base.lock.hash).toBe(true);
  });

  it("locks the tools' own seeds: prisma's `prisma.seed`, a knex seeds folder, sequelize seeders", async () => {
    const prisma = await seedScriptLockOf(cmd("npx", ["prisma", "db", "seed"]), tree({ "package.json": pkg({ prisma: { seed: "tsx prisma/seed.ts" } }), "prisma/seed.ts": "import { PrismaClient } from '@prisma/client';\n" }));
    expect(prisma.ok && prisma.lock.from).toEqual(["package.json", "prisma/seed.ts"]);
    const knex = await seedScriptLockOf(cmd("npx", ["knex", "seed:run"]), tree({ "knexfile.js": "module.exports = { client: 'pg' };\n", "seeds/01_users.js": "exports.seed = async (knex) => {};\n", "seeds/02_posts.js": "exports.seed = async () => {};\n" }));
    expect(knex.ok && knex.lock.from).toEqual(["knexfile.js", "seeds/01_users.js", "seeds/02_posts.js"]);
    const sequelize = await seedScriptLockOf(cmd("npx", ["sequelize-cli", "db:seed:all"]), tree({ "config/config.json": "{}", "seeders/2024-users.js": "module.exports = { up() {} };\n" }));
    expect(sequelize.ok && sequelize.lock.from).toEqual(["config/config.json", "seeders/2024-users.js"]);
  });

  it.each([
    ["its own variables", cmd("npm", ["run", "seed"], { NODE_OPTIONS: "--require ./x.js" }), NPM_SEED, "has_env"],
    ["a pre-script", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js", preseed: "node other.js" } }) }, "pre_post_script"],
    ["a shell line", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node prisma/seed.js && curl x" } }) }, "script_shape"],
    ["a node option before the file", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "package.json": pkg({ scripts: { seed: "node --require ./x.js prisma/seed.js" } }) }, "script_shape"],
    ["a seed file that loads another repository file", cmd("npm", ["run", "seed"]), { ...NPM_SEED, "prisma/seed.js": "const data = require('./data');\n" }, "imports_repo_files"],
    ["a missing script", cmd("npm", ["run", "nope"]), NPM_SEED, "not_a_repo_script"],
    ["a command that is not a script run", cmd("bash", ["-c", "node prisma/seed.js"]), NPM_SEED, "not_a_repo_script"],
    ["a package manager's own command", cmd("yarn", ["install"]), NPM_SEED, "not_a_repo_script"],
    ["a prisma config that can move the seed", cmd("npx", ["prisma", "db", "seed"]), { "package.json": pkg({ prisma: { seed: "node prisma/seed.js" } }), "prisma/seed.js": "x", "prisma.config.ts": "export default {}" }, "tool_config"],
    ["a knexfile that names its own seeds folder", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = { seeds: { directory: './other' } };", "seeds/a.js": "x" }, "tool_config"],
    ["an empty seeds folder", cmd("npx", ["knex", "seed:run"]), { "knexfile.js": "module.exports = {};" }, "no_files"],
    ["a missing seed file", cmd("npm", ["run", "seed"]), { "package.json": NPM_SEED["package.json"] }, "unreadable"],
  ])("refuses %s", async (_name, command, files, refusal) => {
    expect(await seedScriptLockOf(command, tree(files))).toEqual({ ok: false, refusal });
  });

  it("refuses when the reader cannot answer (a host error is never a pass)", async () => {
    expect(await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED, "prisma/seed.js"))).toEqual({ ok: false, refusal: "unreadable" });
    expect(await seedScriptLockOf(cmd("npx", ["knex", "seed:run"]), { read: async (path) => (path === "knexfile.js" ? "module.exports = {};" : undefined), list: async () => undefined })).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("holds only while the checkout resolves to the same hash", async () => {
    const resolved = await seedScriptLockOf(cmd("npm", ["run", "seed"]), tree(NPM_SEED));
    if (!resolved.ok) throw new Error("expected a lock");
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree(NPM_SEED))).toBe(true);
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree({ ...NPM_SEED, "prisma/seed.js": "process.exit(0)" }))).toBe(false);
    expect(await seedLockHolds(cmd("npm", ["run", "seed"]), resolved.lock, tree(NPM_SEED, "prisma/seed.js"))).toBe(false);
  });
});
