// Convergence plan W0-5: Code's port conformance suites, run against (a) Code's fakes and defaults as the positive control and (b) every Cloud adapter in
// adapters/index.ts. How to add an adapter: docs/architecture/cloud-adapter-conformance.md. The suites are Code's own files from the pinned vendored copy.
import { describe, it } from "vitest";
import { CLOUD_ADAPTERS } from "./adapters/index.js";
import { CODE_FAKES } from "./code-fakes.js";
import { PENDING_LANE } from "./pending-lanes.js";
import { RUN_SUITE, type PortName } from "./ports.js";

const ports = Object.keys(RUN_SUITE) as PortName[];
// The registrations are checked against each port's harness type where they are made (defineCloudAdapter, CODE_FAKES), so the lookup here is by port name alone.
const run = RUN_SUITE as Record<PortName, (label: string, harness: unknown) => void>;

describe("port conformance: Code's fakes and defaults (positive control)", () => {
  for (const port of ports) {
    for (const fake of CODE_FAKES[port]) describe(port, () => run[port](fake.name, fake.harness));
  }
});

describe("port conformance: Cloud adapters", () => {
  for (const registration of CLOUD_ADAPTERS) describe(registration.port, () => run[registration.port](`Cloud: ${registration.name}`, registration.harness));
  // A port with no Cloud adapter yet shows as a todo (never as a pass), naming the wave 1 lane that owes it.
  const registered = new Set<string>(CLOUD_ADAPTERS.map((registration) => registration.port));
  for (const port of ports) {
    if (!registered.has(port)) it.todo(`${port}: no Cloud adapter registered yet (${PENDING_LANE[port]})`);
  }
});
