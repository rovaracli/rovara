import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { localToolsPath, readLocalTools } from "../../api/knowledge-switch.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Switch } from "../../design/Switch.js";
import { VisibleText } from "../../design/VisibleText.js";

/** Fixed words (never Code's). */
export const LOCAL_TOOLS_WORDS = {
 TITLE: "Coding tools and lessons",
 LABEL: "Local coding tools can fetch lessons",
 HELP: "When this is on, a coding tool on a person's own computer can ask Rovara for this project's approved team lessons. It reads a few at a time and every read is recorded.",
 WHY_COMPANY: "Your company keeps team knowledge inside Rovara, so coding tools get nothing. A company owner or admin can change that on Company settings.",
 WHY_REGULATED: "This project follows the Regulated preset, which keeps team knowledge inside Rovara, so coding tools get nothing.",
 ONLY_ADMINS: "Only this project's admins, and company owners and admins, can change this.",
 LOADING: "Loading the coding tools setting", SAVE_FAILED: "Couldn't confirm it saved. Reload this page to check.",
 ON: "Saved. Coding tools can fetch this project's lessons.", OFF: "Saved. Coding tools get no lessons from this project.",
} as const;

/** A project's own switch on Project settings. Hidden while Code serves no such route or the setting cannot be read; Code decides who may change it. */
export function LocalToolsSetting({ project }: { project: string }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), client = useQueryClient();
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 const key = ["local-tools", project], path = localToolsPath(project);
 const current = useQuery({ queryKey: key, queryFn: () => api.get(path, { parse: readLocalTools }), retry: false, gcTime: 0 });
 async function change(enabled: boolean) {
  setBusy(true); setMessage(undefined);
  try {
   const saved = await api.sendAnswer("PUT", path, { enabled }, { parse: readLocalTools }, { retry: "never" });
   await client.invalidateQueries({ queryKey: key });
   setMessage({ kind: "status", text: saved.own === false ? LOCAL_TOOLS_WORDS.OFF : LOCAL_TOOLS_WORDS.ON });
  } catch { setMessage({ kind: "alert", text: LOCAL_TOOLS_WORDS.SAVE_FAILED }); } finally { setBusy(false); }
 }
 if (current.isPending) return <Skeleton label={LOCAL_TOOLS_WORDS.LOADING} />;
 if (current.data === undefined) return null;
 const view = current.data;
 // The switch shows the project's own choice (on until it chooses otherwise); a company or preset reason is said beside it and never changes what the project chose.
 const own = view.own ?? true;
 return <section className="rv-project-section" aria-label={LOCAL_TOOLS_WORDS.TITLE} data-testid="local-tools-setting">
  <h2>{LOCAL_TOOLS_WORDS.TITLE}</h2>
  <Switch label={LOCAL_TOOLS_WORDS.LABEL} checked={own} disabled={busy || !view.canChange} help={LOCAL_TOOLS_WORDS.HELP} onCheckedChange={next => { void change(next); }} />
  {view.reason === "company_stays" && <p className="rv-muted" data-testid="local-tools-why">{LOCAL_TOOLS_WORDS.WHY_COMPANY}</p>}
  {view.reason === "regulated" && <p className="rv-muted" data-testid="local-tools-why">{LOCAL_TOOLS_WORDS.WHY_REGULATED}</p>}
  {!view.canChange && <p className="rv-muted">{LOCAL_TOOLS_WORDS.ONLY_ADMINS}</p>}
  {message !== undefined && <p role={message.kind === "alert" ? "alert" : "status"}><VisibleText text={message.text} /></p>}
 </section>;
}
