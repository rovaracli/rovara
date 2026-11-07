// UX3: the two lines every company settings page opens with: what a change here affects, and who can change it. A viewer who can't change it is told why.
import { VisibleText } from "../../design/VisibleText.js";
import { useAdminContext } from "./AdminLayout.js";
import { readOnlyReason, SETTINGS_AREAS, type SettingsAreaId } from "./settings-text.js";
export function SettingsNote({ area }: { area: SettingsAreaId }) {
  const { role } = useAdminContext(), entry = SETTINGS_AREAS[area], why = readOnlyReason(area, role);
  return <aside className="rv-settings-note" aria-label={`About ${entry.title}`}>
    <p><strong>What a change affects.</strong> <VisibleText text={entry.affects} /></p>
    <p><strong>Who can change it.</strong> <VisibleText text={entry.who} /></p>
    {why !== undefined && <p role="note" className="rv-settings-why"><VisibleText text={why} /></p>}
  </aside>;
}
