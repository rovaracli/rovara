// Owner DEC 254zzz540 (rule: the product never claims a protection it does not enforce) after DEC 254zzz73 (step-up removed): no screen word and no contract comment may promise "a sign-in within the last 10 minutes"
// or another recent-sign-in step. A real 401 ("Sign in again") is a different thing and is not matched.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLAIM = /(?:signed in|sign-in|sign in) (?:in|within|inside) the last (?:10|ten) minutes|asked to sign in again if you have not signed in|needs a (?:fresh|recent) sign-in|need a (?:fresh|recent) sign-in/iu;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(path);
    return /\.(?:ts|tsx)$/u.test(name) ? [path] : [];
  });
}

describe("no sign-in step is promised that is not enforced", () => {
  it("has no 'sign-in within the last 10 minutes' or recent-sign-in promise in the screens, the contracts or the server", () => {
    const hits: string[] = [];
    for (const root of ["packages/ui/src", "packages/contracts/src", "packages/cloud-server/src"]) {
      for (const path of sources(root)) {
        readFileSync(path, "utf8").split("\n").forEach((line, index) => { if (CLAIM.test(line)) hits.push(`${path}:${String(index + 1)}`); });
      }
    }
    expect(hits).toEqual([]);
  });
  it("words the approval helps by what is shown, not by a sign-in window or a who-approves rule", async () => {
    const limits = readFileSync("packages/ui/src/screens/setup/limits-text.ts", "utf8");
    const recipes = readFileSync("packages/ui/src/screens/admin/how-we-work/recipes-text.ts", "utf8");
    const design = readFileSync("packages/ui/src/screens/admin/how-we-work/DesignReviewCompanyRow.tsx", "utf8");
    expect(limits).toContain('APPROVE_HELP: "You approve exactly the change shown here."');
    expect(limits).toContain("Setup runs stay held until then.\"");
    expect(recipes).toContain('APPROVE_HELP: "You approve exactly what is shown here, the commands included."');
    expect(design).toContain('APPROVE_HELP: "You confirm exactly what is shown here."');
  });
});

// Their routes (`/v1/app/org/setup-agent/locks*` and `/v1/app/org/design-review`) are `later` in the route table and served by no server: a screen must not say who approves (opus review, DEC 254zzz540).
describe("the two screens whose routes no server serves say nothing about who approves", () => {
  it("has no 'different admin', 'second admin' or 'only one admin' claim in their words", () => {
    const limits = readFileSync("packages/ui/src/screens/setup/limits-text.ts", "utf8");
    const design = readFileSync("packages/ui/src/screens/admin/how-we-work/DesignReviewCompanyRow.tsx", "utf8");
    const locks = readFileSync("packages/ui/src/screens/admin/how-we-work/SetupLocksRow.tsx", "utf8");
    for (const text of [limits, design]) expect(text.replace(/\/\/.*$/gmu, "")).not.toMatch(/different admin|second admin|can approve it|company with one admin/iu);
    expect(locks).not.toContain("SOLE_OWNER");
  });
});
