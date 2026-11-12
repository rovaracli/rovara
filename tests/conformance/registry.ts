// How a Cloud adapter gets Code's conformance suite for its port (convergence plan W0-5; docs/architecture/cloud-adapter-conformance.md).
//
// An adapter lane writes one file in `adapters/` that calls `defineCloudAdapter({ port, name, harness })`, and adds that value to `CLOUD_ADAPTERS` in `adapters/index.ts`.
// `conformance.test.ts` then runs the port's suite (Code's own, from the vendored copy) against it, on every CI test shard, with no further wiring.
import type { PortHarnesses, PortName } from "./ports.js";

/** One Cloud adapter under test: which port it implements, a short name for test output, and the harness that builds a fresh, empty adapter for each test (the type Code's suite for that port takes). */
export type CloudAdapterRegistration = { [P in PortName]: { readonly port: P; readonly name: string; readonly harness: PortHarnesses[P] } }[PortName];

/** Checks the harness against the suite's type for `port` (a wrong harness shape is a type error here, not a failure later) and returns the registration. */
export function defineCloudAdapter<P extends PortName>(registration: { readonly port: P; readonly name: string; readonly harness: PortHarnesses[P] }): CloudAdapterRegistration {
  return registration as CloudAdapterRegistration;
}

/** Why a list of registrations cannot be run, or an empty list. Names are what the test report shows, so a name is one line, and one adapter appears once per port. */
export function registrationProblems(registrations: readonly CloudAdapterRegistration[], ports: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    const label = `${registration.port} / ${registration.name}`;
    if (!ports.includes(registration.port)) problems.push(`${label}: there is no conformance suite for the port "${registration.port}"`);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ,.()_/-]{0,79}$/.test(registration.name)) problems.push(`${label}: the name must be 1 to 80 plain characters`);
    if (seen.has(label)) problems.push(`${label}: registered twice`);
    seen.add(label);
  }
  return problems;
}
