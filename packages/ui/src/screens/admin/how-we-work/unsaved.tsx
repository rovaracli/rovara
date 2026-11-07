// UX3: unsaved-changes handling for the company How we work page. Sections that hold a draft (model defaults, setup locks, design review rules) say when they have one;
// the page then shows a "you have unsaved changes" line naming them, and warns before the person leaves (closing the tab, or moving to another page in the app).
// Each section keeps its own Save and its own server route; nothing here saves anything, and no rule about who may save changes.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
interface Registry { set(id: string, label: string, dirty: boolean): void }
const Context = createContext<Registry | undefined>(undefined);
export const UNSAVED_TITLE = "You have unsaved changes";
export const LEAVE_TITLE = "Leave without saving?";
export function UnsavedChanges({ children }: { children: ReactNode }) {
 const [sections, setSections] = useState<Record<string, string>>({});
 const set = useCallback((id: string, label: string, dirty: boolean) => {
  setSections(current => {
   if (dirty === (id in current)) return current;
   const next = { ...current };
   if (dirty) next[id] = label; else delete next[id];
   return next;
  });
 }, []);
 const labels = Object.values(sections), unsaved = labels.length > 0;
 useEffect(() => {
  if (!unsaved) return;
  const warn = (event: BeforeUnloadEvent) => { event.preventDefault();event.returnValue = ""; };
  window.addEventListener("beforeunload", warn);
  return () => { window.removeEventListener("beforeunload", warn); };
 }, [unsaved]);
 const blocker = useBlocker(unsaved);
 const registry = useMemo<Registry>(() => ({ set }), [set]);
 return <Context.Provider value={registry}>
  {unsaved && <p role="status" className="rv-hww-unsaved"><strong>{UNSAVED_TITLE}</strong> in {labels.join(", ")}. Each section has its own Save button; nothing is saved until you press it.</p>}
  {children}
  <Dialog title={LEAVE_TITLE} description="Your changes in this page are not saved and will be lost." open={blocker.state === "blocked"} onOpenChange={open => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
   <div className="rv-hww-company-actions"><Button variant="primary" onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>Stay and keep editing</Button><Button variant="danger" onClick={() => { if (blocker.state === "blocked") blocker.proceed(); }}>Leave without saving</Button></div>
  </Dialog>
 </Context.Provider>;
}
/** A section with a draft reports it here: `dirty` is true while the draft differs from what is saved. It clears itself when the section goes away. */
export function useReportUnsaved(id: string, label: string, dirty: boolean) {
 const registry = useContext(Context);
 useEffect(() => {
  registry?.set(id, label, dirty);
  return () => { registry?.set(id, label, false); };
 }, [registry, id, label, dirty]);
}
