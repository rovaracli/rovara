// UX-4b: with test services on, a dev container is not offered beside the test environment: the item says why and where to go instead, and the other items are unchanged.
import { describe, expect, it } from "vitest";
import type { SetupItem, StoredProjectDefinition } from "@rovara-code/contracts";
import { SETUP_ITEM_WORDS, unavailableReason } from "../../packages/broker/src/rovara-code/setup-items.js";

const definition = { name: "web", revision: 2, setup: [], readiness: [], repositories: [{ name: "web", url: "https://github.com/acme/web", defaultBranch: "main", path: "." }] } as unknown as StoredProjectDefinition;
const item = (kind: SetupItem["kind"], value: unknown): SetupItem => ({ id: kind + "-1", kind, proposed: { value, from: [], confidence: "high", risk: "safe" } } as unknown as SetupItem);

describe("the dev container offer and test services", () => {
  it("is not offered while test services are on, with the reason and the place to go", () => {
    const devcontainer = item("devcontainer", { repository: "acme/web", configPath: ".devcontainer/devcontainer.json", exists: true });
    expect(unavailableReason(definition, devcontainer, { cards: true, testServices: true })).toBe(SETUP_ITEM_WORDS.devcontainerWithServices);
    expect(SETUP_ITEM_WORDS.devcontainerWithServices).toContain("Set the test environment up instead");
  });

  it("is offered as before with test services off, and other items are unchanged either way", () => {
    const devcontainer = item("devcontainer", { repository: "acme/web", configPath: ".devcontainer/devcontainer.json", exists: true });
    expect(unavailableReason(definition, devcontainer, { cards: true })).toBeUndefined();
    expect(unavailableReason(definition, devcontainer, { cards: true, testServices: false })).toBeUndefined();
    const setup = item("setup", { repo: "web", commands: ["npm ci"] });
    expect(unavailableReason(definition, setup, { cards: true, testServices: true })).toBeUndefined();
  });
});
