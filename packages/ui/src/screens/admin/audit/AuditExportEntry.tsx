import { useState } from "react";
import { Dialog } from "../../../design/Dialog.js";
import { Button } from "../../../design/Button.js";
import { useAppHost } from "../../../host.js";
import { useAdminContext } from "../AdminLayout.js";
import { AUDIT_EXPORT_ENTRY_PATH, AUDIT_VERIFIER_EXTENDS_EXAMPLE } from "./metadata.js";
export function AuditExportEntry({ availability, checkingStatus }: { availability: "ready" | "empty" | "unavailable"; checkingStatus: boolean }) {
 const host = useAppHost(), { role, checking } = useAdminContext();
 const [guideOpen, setGuideOpen] = useState(false);
 const busy = checking || checkingStatus, allowed = (role === "owner" || role === "admin") && availability === "ready" && !busy;
 return <section aria-label="Audit export"><h2>Audit export</h2>
 <p>Open the secure export window to choose a record-number range and whether to include personal details. Your company access is checked again there before an export can start.</p>
 <p>Your time filter is not carried over. Review the export's record-number range before starting. The verifiable bundle may include entire sealed batches around the requested records.</p>
 <p>Format: verifiable JSON bundle (.json.gz). Preparation, on-demand status checks and expiring download links are handled in the secure window. No export starts when you open this console page.</p>
 <Button disabled={!allowed} onClick={() => { if (allowed) host.openExternal(host.origin + AUDIT_EXPORT_ENTRY_PATH); }}>Open secure audit export</Button>
 {busy ? <p role="status">Checking audit export availability...</p> : availability === "empty" ? <p>There are no records to export in this status snapshot.</p> : availability === "unavailable" ? <p>Audit export availability is unknown. Refresh log status before exporting.</p> : null}
 <h3>Check the downloaded file</h3><p>The free offline verifier needs Node 22 and makes no network calls. Keep earlier exports so you can check that newer history extends them. Review the verifier's timestamp trust and coverage instructions.</p>
 <Dialog title="Verify an audit export" open={guideOpen} onOpenChange={setGuideOpen} trigger={<Button>Free verifier instructions</Button>}>
 {guideOpen && <><p>Ask your installation administrator for the free rovara-audit-verify package. Use Node 22 to run it offline; verification makes no network calls.</p><p>Keep the original downloaded bundle. To compare a newer export with an earlier one:</p><p><code>{AUDIT_VERIFIER_EXTENDS_EXAMPLE}</code></p><p>The verifier checks the record chain, seals, included details and timestamps against its pinned authority roots. Bundle-supplied certificates are never trusted. Untimestamped epochs are listed; a successful integrity check does not prove that records are true or complete.</p></>}
 </Dialog>
 </section>;
}
