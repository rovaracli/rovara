import { MY_GITHUB_PATH, readMyGithub } from "../../api/github-link.js";
import { VisibleText } from "../../design/VisibleText.js";
import { LinkBody, Pill, Stamp } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { useScopedRead } from "./read-model.js";

/** Account's "Your GitHub account" row: the link as served. Separate from signing in and from the company's repository access. */
export function GithubLinkReadPanel() {
 const github = useScopedRead(MY_GITHUB_PATH, { parse: readMyGithub });
 return <ReadState query={github} label="your GitHub link" rowLabel="Your GitHub account">{data => data.linked
  ? <LinkBody to="/app/account/github" title="Your GitHub account" detail={<>Linked as <span className="g5-login"><VisibleText text={data.login} /></span>{data.linkedAt !== undefined && <> since <Stamp iso={data.linkedAt} /></>} · lets Rovara recognise your reviews and commits as you</>} chip={<Pill tone="ok">Linked</Pill>} />
  : <LinkBody to="/app/account/github" title="Your GitHub account" detail="No GitHub account connected." />}</ReadState>;
}
