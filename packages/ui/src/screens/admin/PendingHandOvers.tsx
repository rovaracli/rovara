import { viewerTime } from "../../design/viewer-time.js";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MemberRemovalStartedReaderSchema, PendingHandOversReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
type Person = { developerId: string; name: string };
type Pending = ReturnType<typeof PendingHandOversReaderSchema.parse>["handovers"][number];
/**
 * DEC 254zzz101: removals whose hand-over did not finish after the person was removed (for example, the person picked to take over left in between). An owner or admin
 * picks who takes over now and finishes it. A retry after an unknown outcome reuses the same request id, so nothing is handed over twice.
 */
function FinishOne({ pending, self, people, onFinished }: { pending: Pending; self: Person; people: readonly Person[]; onFinished: (message: string) => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [successor, setSuccessor] = useState(self.developerId), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>();
 const attempt = useRef<{ id: string; successor: string } | undefined>(undefined);
 async function finish() {
  if (busy) return;
  if (attempt.current?.successor !== successor) attempt.current = { id: globalThis.crypto.randomUUID(), successor };
  setBusy(true);setMessage(undefined);
  try {
   const result = await api.send("POST", `/v1/app/org/members/${pending.developerId}/handover`, { requestId: attempt.current.id, successorId: successor }, MemberRemovalStartedReaderSchema, { retry: "never" });
   if (result.kind !== "done") { setMessage("The hand-over is pending. Try again to check it.");return; }
   attempt.current = undefined;onFinished(result.value.message);
  } catch (error) {
   const code = error instanceof ApiError ? error.code : "";
   if (code === "SUCCESSOR_INVALID") setMessage("Pick someone who is still in the company to take over.");
   else if (code === "NOT_FOUND") setMessage("There's no hand-over waiting for this person. Reload the page.");
   else if (code === "FORBIDDEN") setMessage("Only an owner can finish an owner's hand-over.");
   else if (code === "HANDOVER_TOO_BIG") setMessage("This person owns too much to hand over in one go.");
   else if (code === "HANDOVER_IN_PROGRESS") setMessage("This removal is still being made. Try again in a few minutes.");
   else if (code === "IDEMPOTENCY_CONFLICT") { attempt.current = undefined;setMessage("Something changed. Try again."); }
   else setMessage("The outcome is unknown. Try again: nothing is handed over twice.");
  } finally { setBusy(false); }
 }
 return <li>
  <VisibleText text={pending.name} /> <span className="rv-muted">(removed {viewerTime(new Date(pending.startedAt), { year: "numeric", month: "numeric", day: "numeric" })})</span>
  <Select label={`Who takes over from ${pending.name}?`} value={successor} disabled={busy} onValueChange={value => { setSuccessor(value); }} options={[{ value: self.developerId, label: `You (${self.name})` }, ...people.filter(person => person.developerId !== self.developerId && person.developerId !== pending.developerId).map(person => ({ value: person.developerId, label: person.name }))]} />
  <Button variant="primary" busy={busy} onClick={() => { void finish(); }}>Finish hand-over</Button>
  {message && <p role="alert">{message}</p>}
 </li>;
}
export function PendingHandOvers({ scope, self, people, onFinished }: { scope: string; self: Person; people: readonly Person[]; onFinished: (message: string) => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["admin", "handovers", scope], queryFn: () => api.get("/v1/app/org/members/handovers", PendingHandOversReaderSchema), gcTime: 0, retry: false });
 if (read.isError) return <p role="alert" className="rv-muted">Couldn't check for hand-overs waiting to be finished.</p>;
 const handovers = read.data?.handovers ?? [];
 if (handovers.length === 0) return null;
 return <section aria-labelledby="rv-pending-handovers"><h2 id="rv-pending-handovers">Hand-overs to finish</h2>
  <p className="rv-muted">These people were removed, but what they owned was not handed over. Pick who takes over now.</p>
  <ul>{handovers.map(pending => <FinishOne key={pending.removalId} pending={pending} self={self} people={people} onFinished={message => { onFinished(message);void read.refetch(); }} />)}</ul>
 </section>;
}
