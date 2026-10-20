// Seeded identifiers for the Rovara Code golden recorder. The golden test replaces node:crypto's randomUUID with
// goldenUuid, so every operation, workspace, outbox and nonce id a scenario makes is the same on every run. This file
// imports nothing from node:crypto, because the mock that uses it is itself a replacement of that module.
let scenario = 0;
let counter = 0;

/** Starts a scenario's id sequence over; scenarios never share ids, so one fixture's ids never appear in another. */
export function seedGoldenIds(scenarioIndex: number): void {
  scenario = scenarioIndex;
  counter = 0;
}

/** The next UUID (version 4, variant 8): the scenario's number, then a counter. */
export function goldenUuid(): `${string}-${string}-${string}-${string}-${string}` {
  counter += 1;
  const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
  return `${hex(scenario, 8)}-0000-4000-8000-${hex(counter, 12)}`;
}
