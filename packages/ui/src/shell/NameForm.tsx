import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SetMyNameBodySchema, SetMyNameResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { Button } from "../design/Button.js";
import { TextField } from "../design/TextField.js";
export const NAME_RULE = "Use 1 to 80 characters. A name can't be an email address.";
/** The form that sets the signed-in person's own display name (`PUT /v1/app/me/name`). The person is the session's; the body is the name alone. */
export function NameForm({ label, initial = "", submit, onSaved, secondary }: { label: string; initial?: string; submit: string; onSaved?: () => void; secondary?: ReactNode }) {
 const host = useAppHost(), query = useQueryClient();
 const [value, setValue] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 async function save(event: FormEvent) {
  event.preventDefault();
  const parsed = SetMyNameBodySchema.safeParse({ name: value });
  if (!parsed.success) { setError(NAME_RULE);return; }
  setBusy(true);setError(undefined);setSaved(false);
  try {
   await createApiClient(host).send("PUT", "/v1/app/me/name", parsed.data, SetMyNameResponseReaderSchema);
   await Promise.all([query.invalidateQueries({ queryKey: ["nav"] }), query.invalidateQueries({ queryKey: ["me"] })]);
   setSaved(true);onSaved?.();
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't save your name. Try again."); } finally { setBusy(false); }
 }
 return <form onSubmit={event => { void save(event); }} className="rv-name-form"><TextField label={label} value={value} maxLength={200} autoComplete="nickname" onChange={event => setValue(event.target.value)} {...(error === undefined ? {} : { error })} /><div className="rv-account-actions"><Button type="submit" variant="primary" busy={busy}>{submit}</Button>{secondary}</div>{saved && <p role="status" className="rv-muted">Saved.</p>}</form>;
}
