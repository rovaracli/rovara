// Convergence lane A4 (cloud/ec2-machines): Cloud's EC2 machines adapter (the workspace session path) under Code's worker-machines suite, with no AWS:
// the real SessionManager over the fake table, the session state machines played by timers, and a worker per instance that checks each invoke token
// with the worker's own verifier (tests/support/session-machines-world.ts).
import { defineCloudAdapter } from "../registry.js";
import { COMPANY_A, createSessionMachinesWorld, invocationFor } from "../../support/session-machines-world.js";

export const ec2SessionWorkerMachines = defineCloudAdapter({
  port: "worker-machines",
  name: "EC2 workspace sessions",
  harness: {
    async create() {
      const world = createSessionMachinesWorld();
      // Code's suite names machines with short keys (`ws-1`); Cloud keys a machine by its workspace id, so each key gets a workspace of the company.
      const workspaces = new Map<string, string>();
      const workspaceOfKey = (machineKey: string): string => {
        let workspaceId = workspaces.get(machineKey);
        if (workspaceId === undefined) {
          workspaceId = world.workspace(COMPANY_A);
          workspaces.set(machineKey, workspaceId);
        }
        return workspaceId;
      };
      return {
        machines: world.machinesFor(COMPANY_A, { workspaceOfKey }),
        // An invocation is for the workspace of the machine it is delivered to: the suite delivers to `ws-2` only.
        invocation: (operationId: string) => invocationFor(workspaceOfKey("ws-2"), operationId),
        spec: (machineKey: string) => ({ machineKey, companyId: COMPANY_A }),
        settle: () => world.settle(),
        dispose: () => world.settle(),
      };
    },
  },
});
