import type { ProjectRole, ProjectSetupStatus } from "@agentx/cloud-contracts/web";
export const projectRoleLabel: Record<ProjectRole, string> = { maintainer: "Maintainer", contributor: "Contributor", collaborator: "Collaborator", viewer: "Viewer" };
export const projectSetupLabel: Record<ProjectSetupStatus, string> = { unchecked: "Not checked yet", checking: "Checking", ready: "Ready", failed: "Failed", outdated: "Out of date" };
