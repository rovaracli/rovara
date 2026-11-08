import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { companyPresetKey, useCompanyPreset, useLessonsApi } from "../../../api/lessons.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { PresetProposalBox } from "../../project/lessons/PresetProposalBox.js";
import { T, failureText } from "../../project/lessons/lessons-text.js";
import { useAdminContext } from "../AdminLayout.js";
import "./how-we-work.css";

/**
 * The company's lessons setting (the learning preset for every project): Standard or Regulated, a button to require a person for every lesson in every project, and the request to go back to Standard
 * with Approve and Cancel for a different owner or admin. Its own chunk. Shown to an owner or admin only (and the server checks again on every read and tap); an install without lessons shows nothing.
 */
export default function LessonsPresetRow() {
 const { role } = useAdminContext(), decider = role === "owner" || role === "admin";
 const api = useLessonsApi(), query = useQueryClient(), read = useCompanyPreset(decider), sending = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<string>();
 if (!decider || read.isPending) return null;
 if (read.error instanceof ApiError && (read.error.code === "NOT_FOUND" || read.error.code === "FORBIDDEN")) return null;
 if (read.data === undefined) return <section aria-label={T.COMPANY_PRESET_TITLE} className="rv-hww-company-card"><h2>{T.COMPANY_PRESET_TITLE}</h2><p role="alert">{T.COMPANY_PRESET_LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>Try again</Button></div></section>;
 const { preset, proposal } = read.data;
 async function run(work: () => Promise<string>) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);setSaved(undefined);
  try { setSaved(await work());await query.invalidateQueries({ queryKey: companyPresetKey }); }
  catch (failure) { setError(failureText(failure, T.PRESET_FAILED));await query.invalidateQueries({ queryKey: companyPresetKey }).catch(() => undefined); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label={T.COMPANY_PRESET_TITLE} className="rv-hww-company-card rv-lessons-preset" aria-busy={busy}>
  <h2>{T.COMPANY_PRESET_TITLE}</h2>
  <p>{preset === "regulated" ? T.COMPANY_PRESET_REGULATED : T.COMPANY_PRESET_STANDARD}</p>
  {preset === "standard" && <Button busy={busy} onClick={() => { void run(async () => { await api.requireCompanyPerson();return T.COMPANY_PRESET_SAVED; }); }}>{T.COMPANY_PRESET_REQUIRE}</Button>}
  {preset === "regulated" && proposal === undefined && <Button variant="quiet" busy={busy} onClick={() => { void run(async () => { const answer = await api.allowCompanyTrial();return answer.needsApproval === true ? T.COMPANY_PRESET_ALLOW_ASKED : T.COMPANY_PRESET_ALLOW_DONE; }); }}>{T.PRESET_ALLOW}</Button>}
  {proposal !== undefined && <PresetProposalBox proposal={proposal} scope="company" canDecide={decider} busy={busy}
   onApprove={() => { void run(async () => { await api.approveCompanyPreset(proposal.changeId);return T.PRESET_APPROVED; }); }}
   onCancel={() => { void run(async () => { await api.cancelCompanyPreset(proposal.changeId);return T.PRESET_CANCELLED; }); }} />}
  {saved !== undefined && <p role="status">{saved}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
