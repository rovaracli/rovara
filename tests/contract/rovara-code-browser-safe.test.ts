// Rovara Code (Plan 6 Task 1): the web app imports `rovara-code.ts`, so nothing it imports, however deep, may reach a Node module.
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as ids from "@rovara-code/contracts";
import * as chains from "@rovara-code/contracts";
import * as org from "@rovara-code/contracts";
import * as sessions from "@rovara-code/contracts";
import * as sessionsNode from "@rovara-code/contracts";
import * as slack from "@rovara-code/contracts";

const root = process.cwd();
const NODE_BUILTINS = ["fs", "path", "crypto", "util", "os", "zlib", "stream", "buffer", "child_process", "url"];

/** Every file the entry imports at run time (type-only imports are erased), and every `node:` or Node built-in import found along the way. */
async function importGraph(entry: string): Promise<{ files: Set<string>; nodeImports: string[] }> {
  const files = new Set<string>();
  const nodeImports: string[] = [];
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    files.add(file);
    const info = ts.preProcessFile(await readFile(path.join(root, file), "utf8"), true, true);
    for (const imported of info.importedFiles) {
      const name = imported.fileName;
      if (name.startsWith(".")) {
        const resolved = ts.resolveModuleName(name, path.join(root, file), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule;
        expect(resolved, `${file} imports ${name}`).toBeDefined();
        if (resolved !== undefined) await visit(path.relative(root, resolved.resolvedFileName));
      } else if (name.startsWith("node:") || NODE_BUILTINS.includes(name)) {
        nodeImports.push(`${file} -> ${name}`);
      }
    }
  };
  await visit(entry);
  return { files, nodeImports };
}

describe("rovara-code.ts is browser-safe", () => {
  it("reaches no Node module through any import", async () => {
    const { files, nodeImports } = await importGraph("packages/contracts/src/rovara-code.ts");
    expect(nodeImports).toEqual([]);
    expect(files.has("packages/contracts/src/rovara-code.ts")).toBe(true);
  });

  it("would notice a Node import (positive control: the Node sibling reaches node:crypto)", async () => {
    const { nodeImports } = await importGraph("packages/contracts/src/rovara-code-node.ts");
    expect(nodeImports.some((entry) => entry.endsWith("node:crypto"))).toBe(true);
  });

  it("is the one definition the modules that used to hold the ids re-export", () => {
    expect(org.OrgIdSchema).toBe(ids.OrgIdSchema);
    expect(chains.ChainRunIdSchema).toBe(ids.ChainRunIdSchema);
    expect(sessions.SessionIdSchema).toBe(ids.SessionIdSchema);
    expect(sessionsNode.SessionBindingSchema).toBe(ids.SessionBindingSchema);
    for (const name of ["SlackTeamIdSchema", "SlackChannelIdSchema", "SlackMessageTimestampSchema"] as const) expect(slack[name]).toBe(ids[name]);
  });
});
