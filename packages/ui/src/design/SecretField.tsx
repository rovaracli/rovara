import { useRef, useState } from "react";
import { TextField } from "./TextField.js";
import { Button } from "./Button.js";
/** The most a key file may hold (Rovara-cloud#308): an API key is one short line; anything larger is not a key file. */
export const SECRET_FILE_MAX_BYTES = 4_096;
/**
 * A write-only value: typed or pasted into a password box, or (with `allowFile`) read from a file the person picks, in the browser only.
 * A file's text fills the same box, trimmed, and is sent only when the person presses the button; it is never shown.
 */
export function SecretField({ label, onSubmit, submitLabel = "Save", allowFile = false }: { label: string; onSubmit: (value: string) => void | Promise<void>; submitLabel?: string; allowFile?: boolean }) {
 const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [fileProblem, setFileProblem] = useState<string | undefined>(undefined), [fromFile, setFromFile] = useState(false);
 const file = useRef<HTMLInputElement>(null);
 async function submit() { if (busy || !value) return;setBusy(true);setFailed(false);try { await onSubmit(value); } catch { setFailed(true); } finally { setValue("");setFromFile(false);setBusy(false); } }
 async function pick(picked: File | undefined) {
  setFileProblem(undefined);
  if (picked === undefined) return;
  if (picked.size > SECRET_FILE_MAX_BYTES) { setFileProblem("That file is too large to be a key file. Choose the file that holds only the key."); return; }
  let text: string;
  try { text = (await picked.text()).trim(); } catch { setFileProblem("That file could not be read. Try again, or paste the key."); return; }
  if (text === "") { setFileProblem("That file is empty. Choose the file that holds the key."); return; }
  setValue(text); setFromFile(true);
 }
 const error = failed ? "Could not save. Enter the value and try again." : fileProblem;
 return <form className="rv-secret-field" onSubmit={event => { event.preventDefault();void submit(); }}>
  <TextField label={label} type="password" value={value} onChange={event => { setValue(event.target.value);setFromFile(false); }} autoComplete="new-password" spellCheck={false} {...(error === undefined ? {} : { error })} {...(fromFile ? { hint: "Read from the file. It is sent only when you press " + submitLabel + "." } : {})} />
  <div className="rv-secret-actions">
   <Button type="submit" variant="primary" busy={busy} disabled={!value}>{submitLabel}</Button>
   {allowFile && <>
    <Button disabled={busy} onClick={() => { file.current?.click(); }}>Upload key file</Button>
    <input ref={file} type="file" hidden aria-label="Upload a file that holds the key" accept=".txt,.key,text/plain" disabled={busy} onChange={event => { void pick(event.target.files?.[0]); event.target.value = ""; }} />
   </>}
  </div>
 </form>;
}
