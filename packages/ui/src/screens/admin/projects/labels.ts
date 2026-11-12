import type { CloudProjectRole, ProjectSetupStatus } from "@agentx/cloud-contracts/web";
/** `unknown` is what a forward-tolerant reader turns a role this version does not know into: it is shown as "Other role" and is never offered as a choice in any role picker. */
export const projectRoleLabel: Record<CloudProjectRole | "unknown", string> = { maintainer: "Maintainer", contributor: "Contributor", collaborator: "Collaborator", viewer: "Viewer", unknown: "Other role" };
/** The words for a role as the server sent it: the four known roles by name, anything else (or nothing) as "Other role". */
export const roleWords = (value: string | undefined): string => value !== undefined && Object.hasOwn(projectRoleLabel, value) ? projectRoleLabel[value as keyof typeof projectRoleLabel] : projectRoleLabel.unknown;
export const projectSetupLabel: Record<ProjectSetupStatus, string> = { unchecked: "Not checked yet", checking: "Checking", ready: "Ready", failed: "Failed", outdated: "Out of date" };
