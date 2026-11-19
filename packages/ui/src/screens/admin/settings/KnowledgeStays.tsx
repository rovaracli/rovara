import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KNOWLEDGE_STAYS_PATH, readKnowledgeStays } from "../../../api/knowledge-switch.js";
import { createApiClient } from "../../../api/client.js";
import { useAppHost } from "../../../host.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";

/** Fixed words. `STAYS` is the one sentence every Rovara knowledge tool says when the switch is on. */
export const KNOWLEDGE_STAYS_WORDS = {
 LABEL: "Knowledge stays in Rovara",
 STAYS: "Your company keeps team knowledge inside Rovara.",
 OPEN: "Rovara's coding tools and outside AI tools can read your team's knowledge. Turn this on to keep it inside Rovara for every project.",
 LOADING: "Loading Knowledge stays in Rovara", SAVE_FAILED: "Couldn't confirm it saved. Reload this page to check.",
 ON: "Saved. Team knowledge stays inside Rovara.", OFF: "Saved. Coding tools can read team knowledge again, project by project.",
} as const;

/** The company's switch on Company settings (owners and admins; Code decides again). Hidden while Code serves no such route or the setting cannot be read. */
export function KnowledgeStays() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), client = useQueryClient();
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 const key = ["admin", "knowledge-stays"];
 const current = useQuery({ queryKey: key, queryFn: () => api.get(KNOWLEDGE_STAYS_PATH, { parse: readKnowledgeStays }), retry: false, gcTime: 0 });
 async function change(stays: boolean) {
  setBusy(true); setMessage(undefined);
  try {
   const saved = await api.sendAnswer("PUT", KNOWLEDGE_STAYS_PATH, { stays }, { parse: readKnowledgeStays }, { retry: "never" });
   await client.invalidateQueries({ queryKey: key });
   setMessage({ kind: "status", text: saved.stays ? KNOWLEDGE_STAYS_WORDS.ON : KNOWLEDGE_STAYS_WORDS.OFF });
  } catch { setMessage({ kind: "alert", text: KNOWLEDGE_STAYS_WORDS.SAVE_FAILED }); } finally { setBusy(false); }
 }
 if (current.isPending) return <Skeleton label={KNOWLEDGE_STAYS_WORDS.LOADING} />;
 // Silent when it cannot be read (a Code that does not serve it yet, or one that is down): nothing is claimed about the company's setting.
 if (current.data === undefined) return null;
 return <section className="rv-admin-card" aria-label={KNOWLEDGE_STAYS_WORDS.LABEL} data-testid="knowledge-stays"><div className="rv-section-head"><h2>{KNOWLEDGE_STAYS_WORDS.LABEL}</h2><span>One choice for every project</span></div>
  <Switch label={KNOWLEDGE_STAYS_WORDS.LABEL} checked={current.data.stays} disabled={busy} help={current.data.stays ? KNOWLEDGE_STAYS_WORDS.STAYS : KNOWLEDGE_STAYS_WORDS.OPEN} onCheckedChange={next => { void change(next); }} />
  {message !== undefined && <p role={message.kind === "alert" ? "alert" : "status"}><VisibleText text={message.text} /></p>}
 </section>;
}
