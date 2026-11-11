// Convergence W0-3, review finding N1. Rovara Code's contracts are bundled into every Lambda. Until the pinned Code declares `sideEffects: false` itself, the
// `beforeBundling` hook (scripts/vendor/mark-code-contracts-pure.mjs, run through markCodeContractsPureCommand) says so for the bundle. Without it a small Lambda
// bundles the whole barrel and the TypeScript compiler (3 to 10 times bigger, loaded on every cold start), and nothing else would notice. So every NodejsFunction in
// infra/ must carry the hook, and a new Lambda cannot be added without it. Remove this test together with the stopgap.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const HOOK = "markCodeContractsPureCommand";

/** Every `new <x>.NodejsFunction(...)` (or `new NodejsFunction(...)`) in the text, with whether its own arguments call the hook inside a `beforeBundling` command hook. */
function nodejsFunctionSites(text: string, file: string): { file: string; line: number; hasHook: boolean }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: { file: string; line: number; hasHook: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (callee === "NodejsFunction") {
        let hasHook = false;
        const find = (inner: ts.Node): void => {
          if (ts.isPropertyAssignment(inner) && inner.name.getText(source) === "beforeBundling" && inner.initializer.getText(source).includes(`${HOOK}(`)) hasHook = true;
          ts.forEachChild(inner, find);
        };
        for (const argument of node.arguments ?? []) find(argument);
        sites.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, hasHook });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const infraFiles = (): string[] => {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(path);
    return /\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name) ? [path] : [];
  });
  return [...walk(join(ROOT, "infra", "lib")), ...walk(join(ROOT, "infra", "bin"))];
};

describe("every Lambda bundle marks Rovara Code's contracts side-effect free", () => {
  const sites = infraFiles().flatMap((path) => nodejsFunctionSites(readFileSync(path, "utf8"), relative(ROOT, path)));

  it("finds the NodejsFunction sites (the shared packagedFunction helper, the audit ledger's three, the operator bundle deployer and the person-proof function), so a scan that finds nothing cannot pass", () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(sites.some((site) => site.file === "infra/lib/control-plane.ts")).toBe(true);
    expect(sites.filter((site) => site.file === "infra/lib/audit-ledger.ts")).toHaveLength(3);
  });

  it("gives each NodejsFunction a beforeBundling command hook that runs markCodeContractsPureCommand", () => {
    expect(sites.filter((site) => !site.hasHook).map((site) => `${site.file}:${String(site.line)}`)).toEqual([]);
  });

  it("keeps the hook script and the command that runs it", () => {
    expect(existsSync(join(ROOT, "scripts", "vendor", "mark-code-contracts-pure.mjs"))).toBe(true);
    const command = readFileSync(join(ROOT, "infra", "lib", "code-contracts-bundling.ts"), "utf8");
    expect(command).toContain("mark-code-contracts-pure.mjs");
  });

  it("fails on a NodejsFunction without the hook, and on one whose hook is not a beforeBundling command", () => {
    const withHook = 'new lambdaNodejs.NodejsFunction(this, "A", { bundling: { commandHooks: { beforeBundling: (dir: string) => [markCodeContractsPureCommand(dir)], afterBundling: () => [] } } });';
    const without = 'new lambdaNodejs.NodejsFunction(this, "B", { bundling: { minify: true } });';
    const wrongHook = 'new lambdaNodejs.NodejsFunction(this, "C", { bundling: { commandHooks: { afterBundling: (dir: string) => [markCodeContractsPureCommand(dir)] } } });';
    expect(nodejsFunctionSites(`${withHook}\n${without}\n${wrongHook}`, "x.ts").map((site) => site.hasHook)).toEqual([true, false, false]);
  });
});
