// Owner decisions 91 and 92: a company-wide share of an agent or a chain is written only after an org owner or admin confirms it on the page. The writers that
// take no confirmation are `setShares` (an agent, `manage` only: used by tests) and the `saveShares*` / `setChainShares` helpers behind the routes. This test
// reads every source file of the broker and fails when one of them is reached from a place that has not been reviewed for it, so a new route or tool can't
// write an `org` share around the approval.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../packages", import.meta.url));

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") return [];
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourcesUnder(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const files = sourcesUnder(PACKAGES).map((path) => ({ path: relative(PACKAGES, path), text: readFileSync(path, "utf8") }));
const usersOf = (name: string): string[] => files.filter((file) => new RegExp(`\\b${name}\\b`, "u").test(file.text)).map((file) => file.path).sort();

describe("the share writers that take no confirmation are reached only from reviewed places", () => {
  it("has read the broker's sources (positive control)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(usersOf("saveShares").length).toBeGreaterThan(0);
  });

  it("setShares has no production caller: only the file that defines it", () => {
    expect(usersOf("setShares")).toEqual(["broker/src/agents/access.ts"]);
  });

  it("saveShares is called only by the agent share route's non-widening path, the confirmed-share handler and the confirmed publish request", () => {
    // publication.ts (experience decision 24, owner decision 91): the company-wide share is written only by the `agent_publication` handler, after an org owner or admin
    // approved the request on the page (`agent_publication_company` rule); the other call is the author's own `edit` share when an agent moves to a project.
    expect(usersOf("saveShares")).toEqual(["broker/src/agents/access.ts", "broker/src/agents/changes.ts", "broker/src/agents/publication.ts"]);
  });

  it("the store writers underneath are reached only from the helpers above and the stores themselves", () => {
    // `AgentStore.replaceShares`, `ChainStore.replaceShares` and `OwnedStore.replaceItemShares` write any share set with no check at all. A route that called
    // one with an `org` principal would skip every name pinned above, so they are pinned too. (This guard is file-level: a new call inside a listed file still
    // needs a reviewer.)
    expect(usersOf("replaceShares")).toEqual(["broker/src/agents/access.ts", "broker/src/agents/store.ts", "broker/src/chains/access.ts", "broker/src/chains/store.ts"]);
    expect(usersOf("replaceItemShares")).toEqual(["broker/src/agents/owned-store.ts", "broker/src/agents/store.ts", "broker/src/chains/store.ts"]);
  });

  it("saveSharesOf and setChainShares are reached only through the chain share route and handler", () => {
    expect(usersOf("saveSharesOf")).toEqual(["broker/src/agents/access.ts", "broker/src/chains/access.ts"]);
    expect(usersOf("setChainShares")).toEqual(["broker/src/chains/access.ts", "broker/src/chains/routes.ts"]);
  });
});
