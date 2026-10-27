// Owner decision 2026-10-27: where the repository has a CODEOWNERS file that covers the changed paths, a code owner has to approve before the pull request is ready.
import { describe, expect, it } from "vitest";
import { codeOwnerVerdict, ownersOfPath, parseCodeOwners } from "../../packages/broker/src/rovara-code/code-owners.js";

const rules = (text: string) => parseCodeOwners(text);
const never = async (): Promise<"unknown"> => "unknown";

describe("parseCodeOwners and ownersOfPath", () => {
  it("takes the last matching rule, in GitHub's way", () => {
    const text = ["# owners", "*       @acme/everyone", "/docs/  @docs-lead", "*.ts @ts-lead", "/src/payments/ @pay-lead @acme/payments  # trailing comment"].join("\n");
    expect(ownersOfPath(rules(text), "README.md")).toEqual(["@acme/everyone"]);
    expect(ownersOfPath(rules(text), "docs/a/b.md")).toEqual(["@docs-lead"]);
    expect(ownersOfPath(rules(text), "src/index.ts")).toEqual(["@ts-lead"]);
    expect(ownersOfPath(rules(text), "src/payments/charge.ts")).toEqual(["@pay-lead", "@acme/payments"]);
  });

  it("an anchored rule matches only from the root, an unanchored directory rule at any depth", () => {
    expect(ownersOfPath(rules("/build/ @a"), "src/build/x.js")).toEqual([]);
    expect(ownersOfPath(rules("/build/ @a"), "build/x.js")).toEqual(["@a"]);
    expect(ownersOfPath(rules("build/ @a"), "src/build/x.js")).toEqual(["@a"]);
    expect(ownersOfPath(rules("docs/*.md @a"), "docs/x.md")).toEqual(["@a"]);
    expect(ownersOfPath(rules("docs/*.md @a"), "docs/deep/x.md")).toEqual([]);
    expect(ownersOfPath(rules("/docs/* @a"), "docs/deep/x.md")).toEqual([]);
    expect(ownersOfPath(rules("/docs/* @a"), "docs/x.md")).toEqual(["@a"]);
  });

  it("supports ** and ?, and is case sensitive on paths", () => {
    expect(ownersOfPath(rules("/src/**/test_*.py @a"), "src/x/y/test_one.py")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/src/**/test_*.py @a"), "src/test_one.py")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/a?.txt @a"), "ab.txt")).toEqual(["@a"]);
    expect(ownersOfPath(rules("/Docs/ @a"), "docs/x")).toEqual([]);
  });

  it("a rule with no owner takes ownership away; emails and malformed owners are not owners", () => {
    expect(ownersOfPath(rules("* @a\n/vendor/\n"), "vendor/x.js")).toEqual([]);
    expect(ownersOfPath(rules("* a@example.com @ok not-an-owner"), "x")).toEqual(["@ok"]);
  });

  it("ignores blank lines, comments and a file that is not text", () => {
    expect(rules("\n# only\n\n")).toEqual([]);
  });
});

describe("codeOwnerVerdict", () => {
  const verdict = (text: string | undefined, paths: string[], approvers: string[], team: (team: string, login: string) => Promise<"member" | "not_member" | "unknown"> = never) =>
    codeOwnerVerdict({ codeOwnersText: text, paths, approverLogins: approvers, teamMember: team });

  it("is satisfied when there is no CODEOWNERS file, or it covers none of the changed paths", async () => {
    expect(await verdict(undefined, ["src/a.ts"], [])).toEqual({ ok: true });
    expect(await verdict("/docs/ @a", ["src/a.ts"], [])).toEqual({ ok: true });
  });

  it("needs an approval from an owner of every covered path, a person matched in any case", async () => {
    expect(await verdict("/src/ @Max-GH", ["src/a.ts"], ["arjun-gh"])).toEqual({ ok: false, owners: "@Max-GH" });
    expect(await verdict("/src/ @Max-GH", ["src/a.ts"], ["max-gh"])).toEqual({ ok: true });
    expect(await verdict("/src/ @a\n/docs/ @b", ["src/x", "docs/y"], ["a"])).toEqual({ ok: false, owners: "@b" });
    expect(await verdict("/src/ @a\n/docs/ @b", ["src/x", "docs/y"], ["a", "b"])).toEqual({ ok: true });
  });

  it("any one of a path's owners is enough", async () => {
    expect(await verdict("/src/ @a @b", ["src/x"], ["b"])).toEqual({ ok: true });
  });

  it("a team owner is satisfied by an approver who is in the team", async () => {
    const team = async (name: string, login: string) => (name === "acme/payments" && login === "arjun-gh" ? "member" as const : "not_member" as const);
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["arjun-gh"], team)).toEqual({ ok: true });
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["max-gh"], team)).toEqual({ ok: false, owners: "@acme/payments" });
  });

  it("a team that cannot be read is not satisfied, and says so (fails closed)", async () => {
    expect(await verdict("/src/ @acme/payments", ["src/x"], ["arjun-gh"], never)).toEqual({ ok: false, unreadable: true });
    // But a person owner who approved settles that path whatever the team lookup says.
    expect(await verdict("/src/ @acme/payments @max-gh", ["src/x"], ["max-gh"], never)).toEqual({ ok: true });
  });

  it("names at most three owners and counts the rest", async () => {
    const result = await verdict("* @a @b @c @d @e", ["x"], []);
    expect(result).toEqual({ ok: false, owners: "@a, @b, @c and 2 more" });
  });

  it("asks about a team once per login however many paths it owns", async () => {
    let asked = 0;
    const team = async () => { asked += 1; return "not_member" as const; };
    await verdict("/src/ @acme/t", ["src/a", "src/b", "src/c"], ["x", "y"], team);
    expect(asked).toBe(2);
  });
});
