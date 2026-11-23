import { useParams } from "react-router";
import { useProject } from "../../../packages/ui/src/api/projects.js";
import { HowWeWorkTab } from "../../../packages/ui/src/screens/project/HowWeWorkTab.js";
import { h } from "./h.js";

/**
 * TEST-ONLY (never imported by production). G4 mounted the rebuilt How we work views on the real project tab, so the old stage cards (six marked rows per stage, model rows, track
 * record, filters, the newer-Rovara-Code notice) no longer have a route. The tests that prove those components keep mounting them here, beside the same project read the tab used.
 * They prove the old component and its handlers, not the real route; the real route is proved by tests/web/g4-ship-mount.test.ts.
 */
export function LegacyHowWeWorkTab() {
 const { name } = useParams(), project = name ?? "", read = useProject(project);
 if (read.data === undefined) return null;
 return h(HowWeWorkTab, { project, canEdit: read.data.you.canEditSettings, repository: read.data.project.repositories[0] });
}
