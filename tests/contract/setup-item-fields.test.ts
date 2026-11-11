// Wire lane D (MB-6): the project setting each kind of setup item sets, by the name the settings origins use. Every origin field has an item kind that sets it, so the lanes that add an applier
// (context sources, intake) get their setting's origin read the same way as the built-in ones.
import { describe, expect, it } from "vitest";
import { PROJECT_ORIGIN_FIELDS, SETUP_ITEM_KINDS, type SetupItem } from "@rovara-code/contracts";
import { settingFieldOf } from "../../packages/broker/src/rovara-code/setup-items.js";

const of = (kind: SetupItem["kind"]) => settingFieldOf({ kind });

describe("settingFieldOf", () => {
  it("names the origin field of every kind that sets a project setting", () => {
    expect(Object.fromEntries(SETUP_ITEM_KINDS.map((kind) => [kind, of(kind)]))).toEqual({
      repository: "repositories", setup: "setup", tests: "readiness", check: "checks", test_environment: undefined, devcontainer: "devcontainer", knowledge: "knowledge",
      spec_target: "specTarget", source: "sources", intake: "intake", allowed_domain: "network", secret: undefined,
    });
  });

  it("covers all of the project's origin fields, each by one kind", () => {
    const fields = SETUP_ITEM_KINDS.map(of).filter((field) => field !== undefined);
    expect([...fields].sort()).toEqual([...PROJECT_ORIGIN_FIELDS].sort());
    expect(new Set(fields).size).toBe(fields.length);
  });
});
