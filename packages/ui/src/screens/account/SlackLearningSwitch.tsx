import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LESSONS_SLACK_PATH, readLessonsSlackSwitch } from "../../api/lessons-slack.js";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Switch } from "../../design/Switch.js";
import { VisibleText } from "../../design/VisibleText.js";

export const SLACK_LEARNING_WORDS = {
 LABEL: "Don't learn from my Slack messages",
 HELP: "Rovara only ever reads replies in a Slack thread it was working in, once, when its work ends. Turn this on and your replies are left out of what Rovara learns, from the next task on. Nothing already learned is changed here.",
 LOADING: "Loading your Slack setting", SAVE_FAILED: "Couldn't confirm it saved. Reload this page to check.", ON: "Saved. Your Slack replies are left out.", OFF: "Saved. Your Slack replies can be learned from again.",
} as const;

/** The person's own switch on the account page (`GET`/`PUT /v1/app/me/lessons-slack`). The person is the session's; the body is the one choice. Hidden while the setting cannot be read. */
export function SlackLearningSwitch() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), client = useQueryClient();
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 const current = useQuery({ queryKey: ["account", "lessons-slack"], queryFn: () => api.get(LESSONS_SLACK_PATH, { parse: readLessonsSlackSwitch }), retry: false, gcTime: 0 });
 async function change(optOut: boolean) {
  setBusy(true); setMessage(undefined);
  try {
   const saved = await api.sendAnswer("PUT", LESSONS_SLACK_PATH, { optOut }, { parse: readLessonsSlackSwitch }, { retry: "never" });
   await client.invalidateQueries({ queryKey: ["account", "lessons-slack"] });
   setMessage({ kind: "status", text: saved.optOut ? SLACK_LEARNING_WORDS.ON : SLACK_LEARNING_WORDS.OFF });
  } catch { setMessage({ kind: "alert", text: SLACK_LEARNING_WORDS.SAVE_FAILED }); } finally { setBusy(false); }
 }
 if (current.isPending) return <Skeleton label={SLACK_LEARNING_WORDS.LOADING} />;
 // Silent when it cannot be read (a Code that does not serve it yet, or one that is down): the switch is simply not shown, and nothing is claimed about the person's setting.
 if (current.data === undefined) return null;
 return <div className="rv-slack-learning" data-testid="slack-learning">
  <Switch label={SLACK_LEARNING_WORDS.LABEL} checked={current.data.optOut} disabled={busy} onCheckedChange={next => { void change(next); }} />
  <p className="rv-muted">{SLACK_LEARNING_WORDS.HELP}</p>
  {message !== undefined && <p role={message.kind === "alert" ? "alert" : "status"}><VisibleText text={message.text} /></p>}
 </div>;
}
