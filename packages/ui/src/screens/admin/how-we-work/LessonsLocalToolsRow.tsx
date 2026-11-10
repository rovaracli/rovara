import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { companyLocalToolsKey, useCompanyLocalTools, useLocalToolsApi } from "../../../api/lessons-local-tools.js";
import { Button } from "../../../design/Button.js";
import { useAdminContext } from "../AdminLayout.js";
import "./how-we-work.css";

const W = {
 TITLE: "Lessons: stay in Rovara", STAYS: "Lessons stay in Rovara: coding tools on your team's computers (Claude Code, Codex, Cursor) get no lessons from any project.",
 MAY: "Coding tools can fetch lessons: a project's team can turn that off, and a project on the Regulated preset never allows it. Lessons they fetch are only the ones every member of the project may read.",
 KEEP: "Keep lessons in Rovara", ALLOW: "Allow coding tools to fetch lessons", SAVED: "Saved.", LOAD_FAILED: "Couldn't read this setting.", TRY_AGAIN: "Try again", FAILED: "Couldn't change that. Try again.", NOT_ALLOWED: "Only a company owner or admin can change this.",
} as const;

/** The company's "lessons stay in Rovara" switch (decision 46b): an owner or admin keeps every project's lessons out of coding tools, or allows them again. Its own chunk; the server checks the role on every read and tap. */
export default function LessonsLocalToolsRow() {
 const { role } = useAdminContext(), decider = role === "owner" || role === "admin";
 const api = useLocalToolsApi(), query = useQueryClient(), read = useCompanyLocalTools(decider), sending = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 if (!decider || read.isPending) return null;
 if (read.error instanceof ApiError && (read.error.code === "NOT_FOUND" || read.error.code === "FORBIDDEN")) return null;
 if (read.data === undefined) return <section aria-label={W.TITLE} className="rv-hww-company-card"><h2>{W.TITLE}</h2><p role="alert">{W.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{W.TRY_AGAIN}</Button></div></section>;
 const stays = read.data.stays;
 async function set(next: boolean) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);setSaved(false);
  try { await api.setCompany(next);setSaved(true);await query.invalidateQueries({ queryKey: companyLocalToolsKey }); }
  catch (cause) { setError(cause instanceof ApiError && cause.code === "FORBIDDEN" ? W.NOT_ALLOWED : W.FAILED);await query.invalidateQueries({ queryKey: companyLocalToolsKey }).catch(() => undefined); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label={W.TITLE} className="rv-hww-company-card" aria-busy={busy}>
  <h2>{W.TITLE}</h2>
  <p>{stays ? W.STAYS : W.MAY}</p>
  {stays ? <Button variant="quiet" busy={busy} onClick={() => { void set(false); }}>{W.ALLOW}</Button> : <Button busy={busy} onClick={() => { void set(true); }}>{W.KEEP}</Button>}
  {saved && <p role="status">{W.SAVED}</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </section>;
}
