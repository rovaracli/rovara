import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api/errors.js";
import { useMachineSizeApi } from "../../api/machine-size.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

export function MachineSizeCard({ project, canEdit }: { project: string; canEdit: boolean }) {
  const api = useMachineSizeApi(), host = useAppHost(), cache = useQueryClient();
  const query = useQuery({ queryKey: ["project", project, "machine-size"], queryFn: () => api.read(project), retry: false });
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsStepUp, setNeedsStepUp] = useState(false);
  if (query.isError && query.error instanceof ApiError && query.error.status === 501) return <section className="rv-proposal-card" aria-label="Machine size"><h3>Machine size</h3><p>Machine size suggestions are not set up on Rovara Code yet.</p></section>;
  if (query.isError && query.error instanceof ApiError && query.error.code === "PROJECT_NOT_FOUND") return <section className="rv-proposal-card" aria-label="Machine size"><h3>Machine size</h3><p role="alert">That project doesn't exist, or you can't use it.</p></section>;
  if (query.isPending) return <section className="rv-proposal-card" aria-label="Machine size"><h3>Machine size</h3><p role="status">Loading measurements.</p></section>;
  if (query.isError || query.data === undefined) return <section className="rv-proposal-card" aria-label="Machine size"><h3>Machine size</h3><p role="alert">Couldn't load machine measurements. Try again.</p><Button onClick={() => { void query.refetch(); }}>Try again</Button></section>;
  const view = query.data;
  const value = selected ?? view.currentSize ?? view.suggestedSize ?? view.choices[0]?.id ?? "";
  const noteOf = (id: string | null) => view.choices.find((choice) => choice.id === id)?.costNote;
  async function save() {
    setBusy(true); setError(undefined); setNeedsStepUp(false);
    try { cache.setQueryData(["project", project, "machine-size"], await api.set(project, value)); setSelected(undefined); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === "REAUTH_REQUIRED") { setError("Confirm it's you again before saving this choice."); setNeedsStepUp(true); }
      else if (caught instanceof ApiError && caught.code === "FORBIDDEN") setError("Only a company owner or admin, or this project's administrator, can change this.");
      else if (caught instanceof ApiError && caught.code === "PROJECT_NOT_FOUND") setError("That project doesn't exist, or you can't use it.");
      else if (caught instanceof ApiError && caught.status === 501) setError("Machine size suggestions are not set up on Rovara Code yet.");
      else setError("Couldn't save this choice. Try again.");
    } finally { setBusy(false); }
  }
  return <section className="rv-proposal-card" aria-label="Machine size"><h3>Machine size</h3>
    <p>{view.measuredPeakMemoryMiB === null ? "Peak memory: not measured yet." : `Measured peak memory: ${Math.ceil(view.measuredPeakMemoryMiB)} MiB.`}{view.testTimeMs === null ? " Test time: not measured yet." : ` Test time: ${Math.ceil(view.testTimeMs / 60000)} min.`}</p>
    <p>{view.suggestedSize === null ? "Suggested size: not available yet." : `Suggested size: ${view.choices.find((choice) => choice.id === view.suggestedSize)?.label ?? "not available"}.`}{noteOf(view.suggestedSize) !== undefined && <> <VisibleText text={noteOf(view.suggestedSize)!} /></>}</p>
    <label>Stored choice <select value={value} disabled={!canEdit || busy} onChange={(event) => setSelected(event.target.value)}>{view.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>
    {noteOf(value) !== undefined && <p aria-label="Cost of the selected size">Cost of this size: <VisibleText text={noteOf(value)!} /></p>}
    {canEdit && <Button variant="primary" busy={busy} onClick={() => { void save(); }}>Save machine size</Button>}
    {error && <p role="alert"><VisibleText text={error} /> {needsStepUp && <Button onClick={() => host.signIn(host.currentPath(), { stepUp: true })}>Confirm it's you</Button>}</p>}
    <p>{view.storedOnlyLine} Today's runs don't use this size yet.</p>
  </section>;
}
