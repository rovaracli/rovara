import { useState } from "react";
import { TextField } from "./TextField.js";
import { Button } from "./Button.js";
export function SecretField({ label, onSubmit, submitLabel = "Save" }: { label: string; onSubmit: (value: string) => void | Promise<void>; submitLabel?: string }) {
 const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
 async function submit() { if (busy || !value) return;setBusy(true);setFailed(false);try { await onSubmit(value); } catch { setFailed(true); } finally { setValue("");setBusy(false); } }
 return <form onSubmit={event => { event.preventDefault();void submit(); }}><TextField label={label} type="password" value={value} onChange={event => setValue(event.target.value)} autoComplete="new-password" spellCheck={false} {...(failed ? { error: "Could not save. Enter the value and try again." } : {})} /><Button type="submit" busy={busy} disabled={!value}>{submitLabel}</Button></form>;
}
