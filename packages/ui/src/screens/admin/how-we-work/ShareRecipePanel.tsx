import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createSetupRecipesApi, type ShareInput } from "../../../api/setup-recipes.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ShareRecipeForm } from "./ShareRecipeForm.js";
import { RECIPES_TEXT } from "./recipes-text.js";

/**
 * On a project's test-environment page: a maintainer can offer the project's approved setup to the company's other projects ("Share as company recipe"). The recipe is built by the server from the approved test environment,
 * waits for a company admin's approval and is offered to nobody before it. Shown only when the server has recipes on, the person may maintain the project, and the project has an approved environment; otherwise nothing.
 */
export function ShareRecipePanel({ project }: { project: string }) {
 const host = useAppHost(), api = useMemo(() => createSetupRecipesApi(host), [host]), sending = useRef(false);
 const info = useQuery({ queryKey: ["setup-recipe-share", project], queryFn: () => api.shareInfo(project), retry: false, refetchOnWindowFocus: false });
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<{ message: string; reauth: boolean }>(), [note, setNote] = useState<string>();
 if (info.data === undefined || !info.data.hasApprovedEnvironment) return null;
 async function share(input: ShareInput): Promise<boolean> {
  if (sending.current) return false;
  sending.current = true;setBusy(true);setError(undefined);setNote(undefined);
  try { await api.share(input);setNote(RECIPES_TEXT.SHARED_FROM_PROJECT);setOpen(false);return true; }
  catch (caught) { setError(caught instanceof ApiError ? { message: caught.message, reauth: caught.code === "REAUTH_REQUIRED" } : { message: RECIPES_TEXT.FAILED, reauth: false });return false; }
  finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label="Company recipe" className="rv-proposal-card">
  <h4>Company recipe</h4>
  <p>Offer this project's approved setup to the company's other projects as a starting point. An admin approves it first.</p>
  {!open && <Button onClick={() => { setOpen(true);setNote(undefined); }}>{RECIPES_TEXT.SHARE_BUTTON}</Button>}
  {open && <ShareRecipeForm project={project} repositories={info.data.repositories} markerFiles={info.data.markerFiles} busy={busy} onShare={share} />}
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{RECIPES_TEXT.SIGN_IN_AGAIN}</Button></>}</p>}
  <p role="status">{note ?? ""}</p>
 </section>;
}
