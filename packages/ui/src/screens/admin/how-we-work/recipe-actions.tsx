import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { isAccessEnded } from "../../../api/served-read.js";
import { createSetupRecipesApi, type SetupRecipe } from "../../../api/setup-recipes.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { visibleText } from "../../../design/VisibleText.js";
import { RECIPES_TEXT } from "./recipes-text.js";

/** What a settled re-read says: it failed at all, and whether it failed because access ended (401 / 403 / 404 or the shared access codes). */
const rereadResult = (again: unknown): { failed: boolean; accessEnded: boolean } => {
 const failed = typeof again === "object" && again !== null && "isError" in again && again.isError === true;
 return { failed, accessEnded: failed && isAccessEnded((again as { error?: unknown }).error) };
};
const problem = (error: unknown): { message: string; stale: boolean } => error instanceof ApiError
 ? { message: error.message, stale: error.code === "CHANGE_STALE" } : { message: RECIPES_TEXT.FAILED, stale: false };

/**
 * The company's setup-recipe writes (approve, reject, change who may use one, stop offering, remove an unreadable one, share a project's setup), one at a time.
 * Each sends exactly one request pinned to the revision and digest of the recipe that was shown; a stale refusal reads the list again and says so.
 */
export function useRecipeActions(reread: () => Promise<unknown>, frozen = false) {
 const host = useAppHost(), api = useMemo(() => createSetupRecipesApi(host), [host]), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>(), [wrote, setWrote] = useState(false), [note, setNote] = useState<string>(), [editing, setEditing] = useState<string>();
 useEffect(() => () => { void query.cancelQueries({ predicate: entry => entry.queryKey[0] === "g4" && entry.queryKey.includes("recipes") }); }, [query]);
 async function run(label: string, work: () => Promise<void>, done?: string): Promise<boolean> {
  // Kept facts after a failed re-read never grant write authority (DEC 324): nothing is sent while the page shows "Reconnecting".
  if (sending.current) return false;
  // The reason is shown, not swallowed, for any control that is still clickable (Save, Share).
  if (frozen) { setError(RECIPES_TEXT.RECONNECTING);return false; }
  sending.current = true;setBusy(label);setError(undefined);setNote(undefined);
  try {
   await work();setEditing(undefined);setWrote(true);
   // The write is done. A re-read that then fails says so next to the success; it never says nothing was changed.
   // A re-read that fails because access ended is not a reconnect: the note keeps the success only, and the access-lost block says the change went through.
   const again = rereadResult(await reread());
   const tail = again.failed && !again.accessEnded ? RECIPES_TEXT.REFRESH_FAILED : undefined;
   if (done !== undefined || tail !== undefined) setNote([done, tail].filter(part => part !== undefined).join(" "));
   return true; }
  catch (caught) {
   const seen = problem(caught);
   if (!seen.stale) { setError(seen.message);return false; }
   // "The list was read again" is only said when that re-read worked.
   setError(rereadResult(await reread()).failed ? RECIPES_TEXT.STALE_NOT_REREAD : RECIPES_TEXT.STALE);return false; }
  finally { sending.current = false;setBusy(undefined); }
 }
 return { api, run, busy, error, note, wrote, editing, setEditing };
}

/** The projects a recipe is offered to. Saving with every box empty offers it to every project. */
export function ScopeEditor({ recipe, projects, busy, frozen = false, onSave, onCancel }: { recipe: SetupRecipe; projects: readonly string[]; busy: boolean; frozen?: boolean; onSave: (projects: string[]) => void; onCancel: () => void }) {
 const [chosen, setChosen] = useState<string[]>(recipe.scope.kind === "projects" ? recipe.scope.projects : []);
 return <fieldset className="g4-scope"><legend>{RECIPES_TEXT.CHANGE_WHO}</legend>
  {projects.map(name => <Checkbox key={name} label={visibleText(name)} checked={chosen.includes(name)} onCheckedChange={checked => { setChosen(checked === true ? [...chosen, name] : chosen.filter(item => item !== name)); }} />)}
  <p className="rv-muted">{RECIPES_TEXT.ALL_BLANK}</p>
  <div className="g4-actions"><Button variant="primary" busy={busy} disabled={frozen} onClick={() => { onSave(chosen); }}>{RECIPES_TEXT.SAVE_WHO}</Button><Button disabled={busy} onClick={onCancel}>{RECIPES_TEXT.CANCEL}</Button></div>
  {frozen && <p className="g4-quiet" role="status">{RECIPES_TEXT.RECONNECTING}</p>}
 </fieldset>;
}
