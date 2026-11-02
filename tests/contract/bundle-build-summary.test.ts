// Review I2 (Opus) and the owner's "shows them": the approver sees WHICH resources change in every stack, with the properties that differ, network/IAM/KMS/policy changes first and marked,
// drift when the installed release is the one being approved, and can write the whole build to a folder to read or diff it.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { diffStack, summariseBuild } from "../../packages/cli/src/upgrade/bundle/build-summary.js";
import { buildAtApproval } from "../../packages/cli/src/upgrade/bundle/build-at-approval.js";
import type { BuiltBundle as Bundle } from "../support/bundle-fixture.js";
import { EnterpriseWorld, SETTINGS_ENT } from "../support/enterprise-approval-world.js";
import { testRunner } from "../support/kit-runner.js";

const made: Bundle[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((bundle) => bundle.cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const t = (resources: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ Resources: resources, ...extra });
const res = (type: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ Type: type, Properties: properties, ...extra });

describe("which resources change, and what is sensitive", () => {
  it("names each added, removed and changed resource with its type and the properties that differ", () => {
    const before = t({ Keep: res("AWS::SSM::Parameter", { Name: "a", Value: "1" }), Gone: res("AWS::SQS::Queue"), Edit: res("AWS::SSM::Parameter", { Name: "b", Value: "1", Type: "String" }) });
    const after = t({ Keep: res("AWS::SSM::Parameter", { Name: "a", Value: "1" }), New: res("AWS::SNS::Topic"), Edit: res("AWS::SSM::Parameter", { Name: "b", Value: "2", Type: "String" }, { DependsOn: ["New"] }) });
    const diff = diffStack("runtime", after, before);
    expect(diff.status).toBe("changed");
    expect(diff.items).toEqual([
      { id: "Edit", type: "AWS::SSM::Parameter", change: "changed", properties: ["DependsOn", "Properties.Value"], categories: [] },
      { id: "New", type: "AWS::SNS::Topic", change: "added", properties: [], categories: [] },
      { id: "Gone", type: "AWS::SQS::Queue", change: "removed", properties: [], categories: [] },
    ]);
    expect([diff.added, diff.removed, diff.changed]).toEqual([1, 1, 1]);
  });

  it("marks network, IAM, KMS and resource-policy resources, whichever way they change", () => {
    const types: Record<string, string> = {
      Sg: "AWS::EC2::SecurityGroup", Fw: "AWS::Route53Resolver::FirewallRule", Role: "AWS::IAM::Role", Key: "AWS::KMS::Key", Bucket: "AWS::S3::BucketPolicy", Perm: "AWS::Lambda::Permission", Plain: "AWS::SQS::Queue",
    };
    const after = t(Object.fromEntries(Object.entries(types).map(([id, type]) => [id, res(type, { X: "2" })])));
    const before = t(Object.fromEntries(Object.entries(types).map(([id, type]) => [id, res(type, { X: "1" })])));
    const categories = Object.fromEntries(diffStack("foundation", after, before).items.map((item) => [item.id, item.categories]));
    expect(categories).toEqual({ Bucket: ["RESOURCE POLICY"], Fw: ["NETWORK"], Key: ["KMS"], Perm: ["RESOURCE POLICY"], Plain: [], Role: ["IAM"], Sg: ["NETWORK"] });
    expect(diffStack("foundation", t({ Sg: res("AWS::EC2::SecurityGroup") }), t({})).items[0]!.categories).toEqual(["NETWORK"]);
    expect(diffStack("foundation", t({}), t({ Sg: res("AWS::EC2::SecurityGroup") })).items[0]).toMatchObject({ change: "removed", categories: ["NETWORK"] });
    expect(diffStack("foundation", t({ R: res("AWS::IAM::Role", { A: 2 }) }), t({ R: res("AWS::IAM::Role", { A: 1 }) })).iamChanged).toBe(true);
  });

  it("shows a name from a template only if it looks like one", () => {
    const diff = diffStack("slack", t({ "Bad\u001b[31mName": res("AWS::SNS::Topic") }), t({}));
    expect(diff.items[0]!.id).toBe("?");
  });

  it("treats a stack that is not deployed, or unreadable, as such, and an identical one as unchanged", () => {
    expect(diffStack("slack", t({}), undefined).status).toBe("new");
    expect(diffStack("slack", t({}), "{nope").status).toBe("unreadable");
    expect(diffStack("slack", t({ A: res("AWS::SNS::Topic") }), t({ A: res("AWS::SNS::Topic") })).status).toBe("unchanged");
  });
});

describe("the summary", () => {
  const build = async (settings = SETTINGS_ENT()) => {
    const world = await EnterpriseWorld.create(made);
    const verified = await world.verify();
    try {
      return { world, built: await buildAtApproval({ bundle: verified, settings, runner: testRunner }) };
    } finally {
      await verified.cleanup();
    }
  };
  const deployedFrom = (built: Awaited<ReturnType<typeof build>>["built"], override: Record<string, string> = {}) => {
    const map = new Map<"access" | "foundation" | "identity" | "runtime" | "control-plane" | "slack", string | undefined>();
    for (const part of ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const) map.set(part, override[part] ?? built.files.find((f) => f.file === `built/templates/${part}.template.json`)!.body.toString("utf8"));
    return map;
  };

  it("lists network, IAM, KMS and policy changes first and marked, then every stack's changes", async () => {
    const { built } = await build();
    const deployed = deployedFrom(built, {
      foundation: t({ Marker: res("AWS::SSM::Parameter", { Name: "/ent/foundation", Type: "String", Value: "old" }), Sg: res("AWS::EC2::SecurityGroup", { GroupDescription: "x" }) }),
      runtime: t({ Role: res("AWS::IAM::Role", { Path: "/old/" }) }),
    });
    const summary = summariseBuild({ built, settings: SETTINGS_ENT(), deployed, confined: true, sandbox: "test sandbox" });
    const text = summary.lines.join("\n");
    const reviewAt = text.indexOf("REVIEW FIRST: 2 network, IAM, KMS or resource-policy changes");
    expect(reviewAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeLessThan(text.indexOf("settings hash"));
    expect(text).toContain("*** NETWORK foundation: - Sg (AWS::EC2::SecurityGroup)");
    expect(text).toContain("*** IAM runtime: - Role (AWS::IAM::Role)");
    expect(text).toContain("    ~ Marker (AWS::SSM::Parameter): Properties.Value");
    expect(text).toContain("The kit ran inside test sandbox.");
    // SK-4 minor 2: the approver is told CDK's own template validation did not run for this build.
    expect(text).toContain("CDK's own template validation was not run for this build");
    // Every stack is compared with what is deployed, not only the access stack.
    expect(summary.diffs.map((d) => [d.part, d.status])).toEqual([["access", "unchanged"], ["foundation", "changed"], ["identity", "unchanged"], ["runtime", "changed"], ["control-plane", "unchanged"], ["slack", "unchanged"]]);
  });

  it("caps a long list and says how to read all of it", async () => {
    const { built } = await build();
    const many = Object.fromEntries(Array.from({ length: 75 }, (_, index) => [`Q${String(index)}`, res("AWS::SQS::Queue")]));
    const summary = summariseBuild({ built, settings: SETTINGS_ENT(), deployed: deployedFrom(built, { slack: t(many) }), confined: true, sandbox: "s" });
    const text = summary.lines.join("\n");
    expect(text).toMatch(/\.\.\. and \d+ more \(write the whole build to a folder with --write-build/);
    expect(summary.lines.filter((line) => /^ {4}[-+~] /.test(line)).length).toBe(60);
  });

  it("calls it drift when the install already runs this release and a stack still differs, and not when it is an upgrade", async () => {
    const { built } = await build();
    const deployed = deployedFrom(built, { foundation: t({ Marker: res("AWS::SSM::Parameter", { Name: "x" }) }) });
    const same = summariseBuild({ built, settings: SETTINGS_ENT(), deployed, confined: true, sandbox: "s", installedVersion: "1.4.0" });
    expect(same.drift).toEqual(["foundation"]);
    expect(same.lines.join("\n")).toMatch(/DRIFT: this install already runs release 1\.4\.0, yet foundation differs/);
    const upgrade = summariseBuild({ built, settings: SETTINGS_ENT(), deployed, confined: true, sandbox: "s", installedVersion: "1.2.3" });
    expect(upgrade.drift).toEqual([]);
    expect(upgrade.lines.join("\n")).not.toContain("DRIFT");
    const clean = summariseBuild({ built, settings: SETTINGS_ENT(), deployed: deployedFrom(built), confined: true, sandbox: "s", installedVersion: "1.4.0" });
    expect(clean.drift).toEqual([]);
  });
});

describe("--write-build", () => {
  it("writes every template, package, the manifest and the summary to a new folder before asking, readable only by the user; and never over a folder with something in it", async () => {
    const world = await EnterpriseWorld.create(made);
    await world.deployAsBuilt();
    const root = await mkdtemp(join(tmpdir(), "write-build-"));
    roots.push(root);
    const target = join(root, "build");
    let askedAfterWrite = false;
    await world.approve({ writeBuildTo: target, yes: false, interactive: true, ask: async () => { askedAfterWrite = (await readdir(target)).includes("summary.txt"); return "y"; } });
    expect(askedAfterWrite).toBe(true);
    expect((await readdir(target)).sort()).toEqual(["manifest.json", "packages", "summary.txt", "templates"]);
    expect((await readdir(join(target, "templates"))).sort()).toEqual(["access.template.json", "control-plane.template.json", "foundation.template.json", "identity.template.json", "runtime.template.json", "slack.template.json"]);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, "manifest.json"))).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8")) as { env: string };
    expect(manifest.env).toBe("ent");
    expect(await readFile(join(target, "summary.txt"), "utf8")).toContain("result hash");
    expect(world.output.join("\n")).toContain(`The whole build was written to ${target}.`);
    // A second approval into the same folder is refused before anything is approved; what was there is untouched.
    await writeFile(join(target, "keep.txt"), "mine");
    const second = await EnterpriseWorld.create(made);
    await second.deployAsBuilt();
    await expect(second.approve({ writeBuildTo: target })).rejects.toThrow(/is not empty/);
    expect(second.puts).toEqual([]);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("mine");

  });

  it("writes the build even when the approval is then refused (so the difference can be read)", async () => {
    const world = await EnterpriseWorld.create(made);
    await world.deployAsBuilt();
    world.world.stacks.set(environmentStackName("ent", "access"), { ...world.world.stacks.get(environmentStackName("ent", "access"))!, template: t({ Other: res("AWS::SNS::Topic") }) });
    const root = await mkdtemp(join(tmpdir(), "write-build-"));
    roots.push(root);
    await expect(world.approve({ writeBuildTo: join(root, "b") })).rejects.toThrow(/access stack is not the deployed one/);
    expect((await readdir(join(root, "b"))).sort()).toContain("summary.txt");
    expect(world.puts).toEqual([]);
  });
});
