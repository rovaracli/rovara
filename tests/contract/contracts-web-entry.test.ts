import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
const root = process.cwd();
async function graph(file: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = await readFile(path.join(root, file), "utf8");
  const info = ts.preProcessFile(source, true, true);
  for (const imported of info.importedFiles) {
    const name = imported.fileName;
    expect(name).not.toMatch(/^(node:|typescript$|@rovara\/audit-verifier)/);
    if (name.startsWith(".")) {
      const resolved = ts.resolveModuleName(name, path.join(root, file), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule;
      expect(resolved, name).toBeDefined();
      if (resolved) await graph(path.relative(root, resolved.resolvedFileName), seen);
    }
  }
  return seen;
}
describe("browser contracts entry", () => {
  it("has an exact, entirely browser-safe import graph", async () => {
    const manifest: unknown = JSON.parse(await readFile("packages/contracts/web-safe-files.json", "utf8"));
    expect([...(await graph("packages/contracts/src/web.ts"))].sort()).toEqual(manifest);
  });
  it("refuses a Node import added to a listed file", async () => {
    const results = await new ESLint().lintText('import { createHash } from "node:crypto"; export const hash = createHash;', { filePath: "packages/contracts/src/web.ts" });
    expect(results.flatMap(result => result.messages).some(message => message.ruleId === "no-restricted-imports")).toBe(true);
  });
  it("configures Zod without runtime code generation", async () => {
    const { configureZodForCsp, SessionIdSchema } = await import("../../packages/contracts/src/web.js");
    const { z } = await import("zod");
    configureZodForCsp();
    expect(z.config().jitless).toBe(true);
    expect(SessionIdSchema.safeParse("ses_" + "a".repeat(20)).success).toBe(true);
  });
  it("emits no Node or TypeScript compiler code into browser assets", async () => {
    const directory = "packages/web/dist/app/assets";
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".js")) continue;
      expect(await readFile(path.join(directory, file), "utf8")).not.toMatch(/node:|ts\.createSourceFile/);
    }
  });
});
