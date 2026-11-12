/**
 * The project People switch (lane exp/project-people). This file is the ONLY place that decides whether the project's People tab, invites into a project, merge-rule editing, the collaborator-approvals switch,
 * the product decisions panel and the join landing are on. Today the switch is a per-device storage key (`rovara.people` = "v2"), the same cheap switch the company switcher uses (company-flags.ts): no contract change,
 * no broker change. Off, every page is exactly as it was and none of these routes is called. The role label "Collaborator" does NOT depend on this switch: wherever a project role is already shown it is shown as it is.
 */
export interface PeopleStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const PEOPLE_STORAGE_KEY = "rovara.people";
export function isPeopleV2On(host: PeopleStorageHost): boolean {
 try { return host.storage.get(PEOPLE_STORAGE_KEY) === "v2"; } catch { return false; }
}
