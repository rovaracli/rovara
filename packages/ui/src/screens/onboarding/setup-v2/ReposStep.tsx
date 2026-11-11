import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { Select } from "../../../design/Select.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { planCreate } from "./repo-plan.js";

type Installation = { installationId: number; accountLogin: string };
export interface ChosenRepos { codeRepositories: string[]; metaRepository: string }

/** Step 2: pick the project's repositories and the meta repo, then create the project (the existing create routes). The choice is told to the page, which remembers the meta repo for the environment check. */
export function ReposStep({ installations, name, description, onBack, onCreated }: { installations: readonly Installation[]; name: string; description: string; onBack: () => void; onCreated: (name: string, chosen: ChosenRepos) => void }) {
 const api = useOnboardingApi(), [installation, setInstallation] = useState(installations[0]?.installationId ?? 0), [code, setCode] = useState<string[]>([]), [meta, setMeta] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [intent, setIntent] = useState(() => crypto.randomUUID());
 const repositories = useQuery({ queryKey: ["github", "repositories", installation], enabled: installation > 0, queryFn: () => api.repositories(installation) });
 const changed = () => setIntent(crypto.randomUUID());
 const plan = planCreate({ codeRepositories: code, metaRepository: meta }), problem = plan.kind === "invalid" && (code.length > 0 || meta !== "") ? plan.reason : undefined;
 async function create() {
  if (plan.kind === "invalid") return;
  setBusy(true);setError(undefined);
  try {
   const common = { ...(name ? { name } : {}), description };
   const result = plan.kind === "meta" ? await api.createFromMeta({ requestId: intent, metaRepository: plan.metaRepository, ...(plan.codeRepositories.length > 0 ? { codeRepositories: plan.codeRepositories } : {}), ...common }) : await api.create({ requestId: intent, repository: plan.repository, ...common });
   onCreated(result.project.definition.name, { codeRepositories: plan.kind === "meta" ? plan.codeRepositories : [plan.repository], metaRepository: plan.kind === "meta" ? plan.metaRepository : "" });
  } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't create the project."); }
  finally { setBusy(false); }
 }
 const available = repositories.data?.repositories ?? [];
 return <>
  <h2>Choose repositories</h2>
  <p>Pick the code repositories this project covers. If there are several, also pick the meta repo: it holds your shared plans, rules and lessons, and Rovara never builds from it.</p>
  {installations.length > 1 && <Select label="GitHub account" value={String(installation)} options={installations.map(item => ({ value: String(item.installationId), label: item.accountLogin }))} onValueChange={value => { setInstallation(Number(value));setCode([]);setMeta("");changed(); }} />}
  {repositories.isPending ? <p role="status">Loading repositories</p> : repositories.isError ? <><p role="alert">Couldn't load repositories.</p><Button onClick={() => { void repositories.refetch(); }}>Try again</Button></> : <>
   <fieldset className="rv-psv2-group"><legend>Code repositories</legend>
    {available.length === 0 && <p>No repositories are available to this GitHub account.</p>}
    {available.map(item => item.project !== undefined
     ? <p className="rv-psv2-choice rv-muted" key={item.githubRepositoryId}><VisibleText text={item.fullName} /> is already in <VisibleText text={item.project} /></p>
     : <Checkbox key={item.githubRepositoryId} label={item.fullName} checked={code.includes(item.fullName) && meta !== item.fullName} disabled={meta === item.fullName} onCheckedChange={value => { setCode(list => value === true ? [...list, item.fullName] : list.filter(entry => entry !== item.fullName));changed(); }} />)}
   </fieldset>
   <fieldset className="rv-psv2-group"><legend>Meta repo</legend>
    <label className="rv-psv2-choice"><input type="radio" name="meta-repository" value="" checked={meta === ""} onChange={() => { setMeta("");changed(); }} />No meta repo (a single repository)</label>
    {available.filter(item => item.project === undefined).map(item => <label className="rv-psv2-choice" key={item.githubRepositoryId}><input type="radio" name="meta-repository" value={item.fullName} checked={meta === item.fullName} onChange={() => { setMeta(item.fullName);setCode(list => list.filter(entry => entry !== item.fullName));changed(); }} /><VisibleText text={item.fullName} /></label>)}
   </fieldset>
  </>}
  {problem !== undefined && <p role="status">{problem}</p>}
  <div className="rv-psv2-actions"><Button onClick={onBack}>Back</Button><Button variant="primary" busy={busy} disabled={plan.kind === "invalid"} onClick={() => { void create(); }}>Create the project</Button></div>
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </>;
}
