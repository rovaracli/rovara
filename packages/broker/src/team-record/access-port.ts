// The ONE access-check port of the record core, for readers outside it (learning v2: the lesson loader, the weekly digest and the panel). A lesson's own audience is a frozen
// snapshot taken when it was learned; this port asks the access records NOW, for the places the lesson was learned from, so a person removed from a channel stops getting
// that channel's lessons. The same check as a record search (`judgeAccess`), with the same fail-closed rules: a restricted place without a record denies, and a record that
// cannot be read throws RUNTIME_UNAVAILABLE (the caller must not treat that as "visible", nor as "hidden").
import { agentXError, scopeAndAncestors, type OrgId } from "@agentx/contracts";
import { createAccessReader, judgeAccess, viewerOfLists } from "./access.js";
import type { TeamRecordTable } from "./types.js";

/** The places one thing (a lesson) was learned from. */
export interface AccessPlaces {
  /** Every place it came from, restricted or not (the places above each are checked too). */
  scopes: readonly string[];
  /** Of those, the places whose own access record it requires: a missing record denies. */
  restrictedScopes: readonly string[];
  /** When the snapshot it carries was read (used only for a place whose member list was never seeded). */
  capturedAt?: string | undefined;
}

export interface AccessViewerLists {
  principals: readonly string[];
  groups: readonly string[];
}

export interface AccessCheckPort {
  /**
   * One answer per entry of `places`: whether the viewer may read every place in it right now. A viewer of `undefined` is a shared task (nobody in particular): it may read only
   * places no record restricts. Throws RUNTIME_UNAVAILABLE when a record cannot be read.
   */
  mayRead(orgId: OrgId, viewer: AccessViewerLists | undefined, places: readonly AccessPlaces[]): Promise<boolean[]>;
}

export function createAccessCheckPort(table: TeamRecordTable): AccessCheckPort {
  return {
    async mayRead(orgId, viewer, places) {
      const reader = createAccessReader(table, orgId);
      const who = viewer === undefined ? undefined : viewerOfLists(viewer);
      const units = places.map((place) => ({
        all: [...new Set([...place.restrictedScopes, ...place.scopes].flatMap((scope) => scopeAndAncestors(scope)))], own: place.restrictedScopes, capturedAt: place.capturedAt,
      }));
      await reader.load(units.flatMap((unit) => unit.all), who);
      return units.map((unit) => {
        const verdict = judgeAccess(reader, who, unit);
        if (verdict === "unavailable") throw agentXError("RUNTIME_UNAVAILABLE", "The team record can't be read right now.");
        return verdict === "allow";
      });
    },
  };
}
