// Learning v2 L5: the rows of the task page's "What the agent loaded" panel for lessons (design §1.2, §4.7). The shell of the panel belongs to the K1 design;
// this supplies the lesson rows. A lesson from a restricted source is shown to a person who may not see that source as an opaque row: no title, no text.
import { OrgIdSchema } from "@agentx/contracts";
import type { LessonStore, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { isRestricted, lessonPlaces, satisfiesAcl, type IdentitySet, type Lesson } from "./types.js";

export interface PanelRow {
  stage: string; round: number; lessonId: string; version: number; why: "scope" | "similar" | "path";
  citation: "unchecked" | "valid" | "moved" | "stale_dropped" | "unchecked_dropped" | "none";
  /** False when the viewer may not see the lesson's source: the row then carries no text. */
  visible: boolean;
  title?: string; type?: Lesson["type"]; helpful?: number; harmful?: number;
  /** "Helpful" and "Wrong here" are offered only on a lesson the viewer can see. */
  canMark: boolean;
}

export async function lessonPanelRows(store: LessonStore, key: ScopeKey, taskId: string, viewer: IdentitySet, access: AccessCheckPort, log?: (event: string, fields: Record<string, unknown>) => void): Promise<PanelRow[]> {
  const rows: PanelRow[] = [];
  for (const manifest of await store.manifests(key, taskId)) {
    for (const entry of manifest.lessons) {
      const lesson = await store.get(key, entry.id);
      const base = { stage: manifest.stage, round: manifest.round, lessonId: entry.id, version: entry.version, why: entry.why, citation: entry.citation };
      if (lesson === undefined) { rows.push({ ...base, visible: false, canMark: false }); continue; }
      const places = lessonPlaces(lesson);
      // The frozen snapshot AND the access records now (an unreadable record fails the call).
      if ((access as AccessCheckPort | undefined) === undefined) { log?.("learning.panel_no_access_port", {}); rows.push({ ...base, visible: false, canMark: false }); continue; } // fail closed
      const stillOpen = places.scopes.length === 0 || (await access.mayRead(OrgIdSchema.parse(key.workspaceId), viewer, [places]))[0] === true;
      const visible = (!isRestricted(lesson) || (lesson.provenance.audience.kind === "restricted" && satisfiesAcl(viewer, lesson.provenance.audience.acl))) && stillOpen;
      rows.push(visible
        ? { ...base, visible, title: lesson.title, type: lesson.type, helpful: lesson.counters.helpful, harmful: lesson.counters.harmful, canMark: true }
        : { ...base, visible, canMark: false });
    }
  }
  return rows;
}
