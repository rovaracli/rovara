import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// An image that runs `tsc -b <packages>` builds from what the Dockerfile COPYs. A package that one of those packages imports (`@agentx/<name>`) must therefore be copied (sources, not only its package.json) before the
// build, and be built by it: named on the `tsc -b` line or reachable from it through tsconfig project references. The 0.5.14 Slack image broke on exactly this (slack-service imported @agentx/cloud-contracts, which
// the image never copied or built), and CI builds no Slack image, so only a check of the Dockerfile text catches it.

interface Workspace {
  dir: string;
  name: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const workspaces: Workspace[] = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`packages/${entry.name}/package.json`))
  .map((entry) => ({ dir: `packages/${entry.name}`, name: String(readJson(`packages/${entry.name}/package.json`).name) }));
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace.dir]));

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The workspace directories a package's own sources import through `@agentx/<name>[/subpath]`. */
function importedWorkspaces(dir: string): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(`${dir}/src`)) {
    for (const match of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@agentx\/[^"'/]+)(?:\/[^"']*)?["']/gu)) {
      const target = byName.get(match[1]!);
      if (target !== undefined && target !== dir) found.add(target);
    }
  }
  return [...found].sort();
}

/** The Rovara Code packages a package's own sources import through `@rovara-code/<name>[/subpath]` (shims under vendor/rovara-code-shims over the pinned copy under vendor/rovara-code/packages/<name>). */
function importedVendorPackages(dir: string): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(`${dir}/src`)) {
    for (const match of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']@rovara-code\/([^"'/]+)(?:\/[^"']*)?["']/gu)) found.add(match[1]!);
  }
  return [...found].sort();
}

/** The workspace directories a package's tsconfig.json references (the projects `tsc -b` builds first). */
function referencedWorkspaces(dir: string): string[] {
  const tsconfig = `${dir}/tsconfig.json`;
  if (!existsSync(tsconfig)) return [];
  // tsconfig files may carry comments and trailing commas, so read them with TypeScript's own parser.
  const references = ((ts.readConfigFile(tsconfig, (file) => ts.sys.readFile(file)).config as { references?: { path: string }[] }).references ?? []);
  return references.map((reference) => normalize(join(dir, reference.path))).filter((path) => workspaces.some((workspace) => workspace.dir === path));
}

function built(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    referencedWorkspaces(dir).forEach(visit);
  };
  roots.forEach(visit);
  return seen;
}

/** Problems with one Dockerfile's build stage. Empty when every imported workspace package is copied (whole directory, before the build) and built. */
export function imageClosureProblems(dockerfile: string): string[] {
  const lines = dockerfile.split("\n");
  const problems: string[] = [];
  const buildLine = lines.findIndex((line) => /^RUN\s.*\btsc -b\s/u.test(line));
  if (buildLine < 0) return problems;
  const roots = lines
    .filter((line) => /^RUN\s.*\btsc -b\s/u.test(line))
    .flatMap((line) => [...line.matchAll(/\bpackages\/[a-z0-9-]+(?=\s|$)/gu)].map((match) => match[0]));
  const copiedBefore = (dir: string, atLine: number): boolean =>
    lines.slice(0, atLine).some((line) => new RegExp(`^COPY\\s+${dir}\\s+${dir}\\s*$`, "u").test(line));
  const lastBuildLine = lines.map((line, index) => (/^RUN\s.*\btsc -b\s/u.test(line) ? index : -1)).filter((index) => index >= 0).at(-1)!;
  const builtSet = built(roots);
  // Every package the build compiles, and everything those import, transitively.
  const needed = new Set<string>();
  const walk = (dir: string): void => {
    if (needed.has(dir)) return;
    needed.add(dir);
    importedWorkspaces(dir).forEach(walk);
  };
  builtSet.forEach(walk);
  for (const dir of [...needed].sort()) {
    if (!copiedBefore(dir, lastBuildLine)) problems.push(`${dir} is compiled or imported by a built package but not COPYed whole before the tsc -b line`);
  }
  for (const dir of builtSet) {
    for (const imported of importedWorkspaces(dir)) {
      if (!builtSet.has(imported)) problems.push(`${dir} imports ${imported}, which the tsc -b line neither names nor reaches through tsconfig references`);
    }
  }
  // Rovara Code's packages (`@rovara-code/<name>`): the pinned copy and the shim over it are both needed to build, whichever package imports them.
  const neededVendor = [...new Set([...needed].flatMap(importedVendorPackages))].sort().map((name) => `vendor/rovara-code/packages/${name}`);
  for (const dir of neededVendor) {
    if (!copiedBefore(dir, lastBuildLine)) problems.push(`${dir} is imported (as @rovara-code/*) by a built package but not COPYed whole before the tsc -b line`);
  }
  if (neededVendor.length > 0 && !copiedBefore("vendor/rovara-code-shims", lastBuildLine)) problems.push("vendor/rovara-code-shims is not COPYed before the tsc -b line, but a built package imports @rovara-code/*");
  // The runtime stage: what the built packages import at run time must be shipped in it. Checked for images whose last stage copies packages out of the build stage one by one.
  const lastFrom = lines.map((line, index) => (/^FROM\s/u.test(line) ? index : -1)).filter((index) => index >= 0).at(-1)!;
  const finalStage = lines.slice(lastFrom);
  if (finalStage.some((line) => /^COPY --from=build \/opt\/agentx\/packages\//u.test(line))) {
    for (const dir of [...needed, ...neededVendor, "vendor/rovara-code-shims"].sort()) {
      if (dir === "vendor/rovara-code-shims" && neededVendor.length === 0) continue;
      if (!finalStage.some((line) => new RegExp(`^COPY --from=build /opt/agentx/${dir} \\./${dir}\\s*$`, "u").test(line))) problems.push(`${dir} is needed at run time but the last stage does not copy it from the build stage`);
    }
  }
  return problems;
}

const dockerfiles = readdirSync("environments", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`environments/${entry.name}/Dockerfile`))
  .map((entry) => `environments/${entry.name}/Dockerfile`);

describe("image Dockerfiles copy and build every workspace package their built packages import", () => {
  it("covers the Slack image and the other images that run tsc -b", () => {
    expect(dockerfiles).toContain("environments/slack/Dockerfile");
    const building = dockerfiles.filter((path) => /^RUN\s.*\btsc -b\s/mu.test(readFileSync(path, "utf8")));
    expect(building).toEqual(expect.arrayContaining(["environments/base/Dockerfile", "environments/slack/Dockerfile", "environments/e2e-executor/Dockerfile", "environments/mcp-runner/Dockerfile"]));
  });

  it.each(dockerfiles)("%s", (path) => {
    expect(imageClosureProblems(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("sees that slack-service imports cloud-contracts, declares it, and references it (so the check has something to find)", () => {
    expect(importedWorkspaces("packages/slack-service")).toContain("packages/cloud-contracts");
    const dependencies = readJson("packages/slack-service/package.json").dependencies as Record<string, string>;
    expect(dependencies["@agentx/cloud-contracts"]).toBe("0.1.0");
    expect(referencedWorkspaces("packages/slack-service")).toContain("packages/cloud-contracts");
  });

  it("ships the built cloud-contracts in the Slack runtime stage, which imports it at run time", () => {
    expect(readFileSync("environments/slack/Dockerfile", "utf8")).toContain("COPY --from=build /opt/agentx/packages/cloud-contracts ./packages/cloud-contracts");
  });

  it("rejects the Slack Dockerfile without the cloud-contracts sources (the 0.5.14 break: only its package.json was copied)", () => {
    const broken = readFileSync("environments/slack/Dockerfile", "utf8")
      .split("\n")
      .filter((line) => !/^COPY packages\/cloud-contracts packages\/cloud-contracts$/u.test(line))
      .join("\n");
    expect(broken).toContain("COPY packages/cloud-contracts/package.json");
    expect(imageClosureProblems(broken).join("\n")).toContain("packages/cloud-contracts is compiled or imported by a built package but not COPYed");
  });

  it("rejects a runtime stage that leaves out a package the built packages import (the 0.5.14 Slack image shipped without cloud-contracts)", () => {
    const noRuntimeCopy = readFileSync("environments/slack/Dockerfile", "utf8")
      .split("\n")
      .filter((line) => !/^COPY --from=build \/opt\/agentx\/packages\/cloud-contracts /u.test(line))
      .join("\n");
    expect(imageClosureProblems(noRuntimeCopy).join("\n")).toContain("packages/cloud-contracts is needed at run time but the last stage does not copy it");
  });

  it("rejects a missing Rovara Code package copy for an @rovara-code/* import", () => {
    const noVendor = readFileSync("environments/slack/Dockerfile", "utf8")
      .split("\n")
      .filter((line) => !/^COPY vendor\/rovara-code\/packages\/contracts /u.test(line))
      .join("\n");
    expect(imageClosureProblems(noVendor).join("\n")).toContain("vendor/rovara-code/packages/contracts is imported (as @rovara-code/*) by a built package but not COPYed");
  });

  it("rejects the Slack Dockerfile as it was on integ/0515 878448587 (orchestrator and slack-service import cloud-contracts; the image copied and built neither its sources nor the project)", () => {
    // That Dockerfile, as text: only the package.json of cloud-contracts was copied, `tsc -b` named two packages, and the runtime stage shipped no cloud-contracts.
    const integ = readFileSync("environments/slack/Dockerfile", "utf8")
      .split("\n")
      .filter((line) => !/^(COPY packages\/cloud-contracts packages\/cloud-contracts|COPY --from=build \/opt\/agentx\/packages\/cloud-contracts )/u.test(line) && !line.startsWith("# slack-service imports @agentx/cloud-contracts") && !line.startsWith("# -> slack-service"))
      .join("\n")
      .replace("tsc -b packages/cloud-contracts packages/orchestrator", "tsc -b packages/orchestrator");
    const problems = imageClosureProblems(integ).join("\n");
    expect(problems).toContain("packages/cloud-contracts is compiled or imported by a built package but not COPYed whole before the tsc -b line");
    expect(problems).toContain("packages/cloud-contracts is needed at run time but the last stage does not copy it");
  });

  it("rejects a package copied only after the build", () => {
    const copiedLate = readFileSync("environments/slack/Dockerfile", "utf8")
      .split("\n")
      .filter((line) => !/^COPY packages\/cloud-contracts packages\/cloud-contracts$/u.test(line))
      .join("\n")
      .replace("RUN npm prune", "COPY packages/cloud-contracts packages/cloud-contracts\nRUN npm prune");
    expect(imageClosureProblems(copiedLate).join("\n")).toContain("not COPYed whole before");
  });
});
