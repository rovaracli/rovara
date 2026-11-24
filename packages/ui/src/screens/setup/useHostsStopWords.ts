import { useQuery } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { journalKey } from "./RunJournal.js";
import { hostsStopWords } from "./words.js";

/**
 * The sentence for a setup run that stopped on addresses, chosen by cause (see `hostsStopWords`). The cause is read from the run's address requests: the journal read the screen already makes (same key, so one
 * request). While `active` is false nothing is read. A read that is pending or failed gives the words true of every cause, never a guess.
 */
export function useHostsStopWords(project: string, active: boolean): string {
  const api = useSetupAgentApi();
  const journal = useQuery({ queryKey: journalKey(project), queryFn: () => api.journal(project, { retry: "never" }), retry: false, enabled: active });
  return hostsStopWords(journal.isSuccess ? journal.data.hostAsks : undefined);
}
