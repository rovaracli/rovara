import type { ProjectRole, ProjectSetupStatus } from "@agentx/contracts/web";
export const projectRoleLabel: Record<ProjectRole, string> = { maintainer: "Maintainer", contributor: "Contributor", viewer: "Viewer" };
export const projectSetupLabel: Record<ProjectSetupStatus, string> = { unchecked: "Not checked yet", checking: "Checking", ready: "Ready", failed: "Failed", outdated: "Out of date" };
