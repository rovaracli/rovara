// STOPGAP (convergence W0-3, review H3) until Rovara Code's contracts package declares `"sideEffects": false` itself (branch fix/code-contracts-side-effects of Code) and the pin is moved to a
// commit that has it. A bundler keeps every module of a package that does not say its modules are free of side effects, so a small Lambda would carry all of Code's contracts and the TypeScript
// compiler one of them imports. This writes the one small file that says it for Code's BUILT contracts (vendor/rovara-code/packages/contracts/dist/package.json: build output, git-ignored,
// never part of the pinned tree or its hash), the way Cloud's own contracts package says it in its package.json. Run by the Lambda bundling's beforeBundling hook (infra/lib/code-contracts-bundling.ts).
// Delete this file, that hook and the three side-effect plugins (packages/web/vite.config.ts, scripts/release/signer/build.mjs, environments/mcp-runner/bundle.mjs) when the pin has the flag.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const dist = join(root, "vendor", "rovara-code", "packages", "contracts", "dist");
const manifest = `${JSON.stringify({ type: "module", sideEffects: false }, null, 2)}\n`;
if (!existsSync(dist)) {
  console.error(`mark-code-contracts-pure: ${dist} does not exist: build first (npm run build)`);
  process.exit(1);
}
const file = join(dist, "package.json");
if (!existsSync(file) || readFileSync(file, "utf8") !== manifest) writeFileSync(file, manifest);
