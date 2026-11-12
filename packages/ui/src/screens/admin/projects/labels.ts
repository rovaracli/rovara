import type { CloudProjectRole, ProjectSetupStatus } from "@agentx/cloud-contracts/web";
export const projectRoleLabel: Record<CloudProjectRole, string> = { maintainer: "Maintainer", contributor: "Contributor", collaborator: "Collaborator", viewer: "Viewer" };
export const projectSetupLabel: Record<ProjectSetupStatus, string> = { unchecked: "Not checked yet", checking: "Checking", ready: "Ready", failed: "Failed", outdated: "Out of date" };
