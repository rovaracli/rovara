// exp/automations: the lists and tokens the automation screens copy must match their sources, so a drift fails here and not in a blank <select> or an unstyled box.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EVENT_SOURCES, EVENT_TYPES as CODE_EVENT_TYPES, SCHEDULE_INTERVAL_MINUTES } from "@rovara-code/contracts";
import { lookV2Css, tokensCss } from "../../packages/design-tokens/src/index.js";
import { EVENT_SOURCE_NAMES, EVENT_TYPES, SCHEDULE_INTERVALS } from "../../packages/ui/src/screens/automations/automation-text.js";

it("offers exactly the event sources, event types and schedule intervals Rovara Code defines (a trigger being edited always finds its own type)", () => {
  expect(EVENT_SOURCE_NAMES.map(([source]) => source)).toEqual([...EVENT_SOURCES]);
  expect(EVENT_TYPES).toEqual(CODE_EVENT_TYPES);
  expect(EVENT_TYPES.github).toEqual(expect.arrayContaining(["issues.labeled", "issues.assigned"]));
  expect(EVENT_TYPES.jira).toEqual(expect.arrayContaining(["issue.labeled", "issue.assigned"]));
  expect([...SCHEDULE_INTERVALS]).toEqual([...SCHEDULE_INTERVAL_MINUTES]);
});

it("uses only design tokens that exist (a token with no definition paints nothing)", () => {
  const defined = new Set([...(tokensCss() + lookV2Css() + readFileSync(new URL("../../packages/ui/src/design/design.css", import.meta.url), "utf8")).matchAll(/(--rv-[a-z0-9-]+):/gu)].map(match => match[1]!));
  const css = readFileSync(new URL("../../packages/ui/src/screens/automations/automations.css", import.meta.url), "utf8");
  const used = [...css.matchAll(/var\((--rv-[a-z0-9-]+)/gu)].map(match => match[1]!);
  expect(used.length).toBeGreaterThan(5);
  expect(used.filter(name => !defined.has(name))).toEqual([]);
  expect(css).not.toContain("--rv-status-danger");
});
