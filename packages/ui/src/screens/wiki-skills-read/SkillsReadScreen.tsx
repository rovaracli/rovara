import { useState } from "react";
import { SKILL_LIMITS, SkillsListReader, useRead, useScope } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { SkillDetailReadPanel } from "./SkillDetailReadPanel.js";
import { Chip, Header, HeadRow, Notice, Row, Rows, Section } from "./parts.js";

export type Skill = { name: string; description: string; currentVersion: number; activeVersion?: number | undefined; approvals: number; approvedByYou: boolean; retired: boolean };
export const approvals = (skill: Pick<Skill, "approvals" | "approvedByYou">) => String(Math.min(skill.approvals, SKILL_LIMITS.approversRequired)) + " of " + String(SKILL_LIMITS.approversRequired) + " approvals" + (skill.approvedByYou ? " · you approved" : "");
/** The version in use was approved by the required people before tasks used it; approvals served are for the newest version only. */
const approved = String(SKILL_LIMITS.approversRequired) + " of " + String(SKILL_LIMITS.approversRequired) + " approvals";
export function SkillName({ skill, onOpen }: { skill: Skill; onOpen: (name: string) => void }) {
 return <button type="button" aria-label={"Open " + skill.name} onClick={() => { onOpen(skill.name); }}>{skill.name}</button>;
}
export function SkillsReadScreen() {
 const { project } = useScope();
 const read = useRead("skills", "skills", SkillsListReader), [open, setOpen] = useState<string>();
 const rows: readonly Skill[] = read.data?.skills ?? [];
 const live = rows.filter(skill => !skill.retired), waiting = live.filter(skill => skill.activeVersion !== skill.currentVersion), inUse = live.filter(skill => skill.activeVersion !== undefined), gone = rows.filter(skill => skill.retired);
 const meta = (data: typeof read.data) => data === undefined || data.partial ? "Skills" : "Skills · " + String(inUse.length) + " in use · " + String(waiting.length) + " waiting · " + String(gone.length) + " retired";
 const opened = open === undefined ? undefined : rows.find(skill => skill.name === open);
 return <ReadState read={read} staleLine={opened === undefined} label="the skills" code="WIKI-SKILLS-READ-FAILED" header={(confirmed, readAt) => opened !== undefined && confirmed ? null : <Header project={project} trail={["Skills"]} {...(confirmed ? { meta: meta(read.data), readAt } : {})} />}>{read.data !== undefined && (opened !== undefined
 ? <SkillDetailReadPanel key={opened.name} skill={opened} canDecide={read.data.canDecide && !read.isError && read.failureCount === 0} onBack={() => { setOpen(undefined); }} />
 : <div className="rv-wsr-page">
 <HeadRow title={"Skills in " + project} text="A skill is a short, saved way of doing one recurring job in this repo, such as adding a migration. Each version needs two different people to approve it before tasks use it." />
 {read.data.partial && <Notice>Can&apos;t tell yet. This skills read is partial; some records could not be read.</Notice>}
 {waiting.length > 0 && <Section title="Waiting for a decision"><Rows label="Waiting for a decision">{waiting.map(skill => <Row key={skill.name} title={<SkillName skill={skill} onOpen={setOpen} />} detail={skill.description} side={<>{skill.activeVersion === undefined ? <Chip icon="dash" dashed>Not in use yet</Chip> : <Chip tone="attention">{"Version " + String(skill.currentVersion) + " to review"}</Chip>}<span className="rv-wsr-meta">{approvals(skill)}</span></>} />)}</Rows></Section>}
 {inUse.length > 0 && <Section title="In use"><div className="rv-wsr-tablewrap"><table className="rv-wsr-table" aria-label="Skills in use"><thead><tr><th scope="col">Skill</th><th scope="col">Version</th><th scope="col">Approvals</th></tr></thead><tbody>{inUse.map(skill => <tr key={skill.name}><td><div className="rv-wsr-skillcell"><strong><SkillName skill={skill} onOpen={setOpen} /></strong><span>{skill.description}</span></div></td><td>{"v" + String(skill.activeVersion)}</td><td>{skill.activeVersion === skill.currentVersion ? approvals(skill) : approved}</td></tr>)}</tbody></table></div><p className="rv-wsr-note">Used by: Can&apos;t tell yet. A running task keeps the version it started with.</p></Section>}
 {!read.data.partial && live.length === 0 && <Notice>No current skills in this read.</Notice>}
 {gone.length > 0 && <Section title="Retired"><Rows label="Retired skills">{gone.map(skill => <Row key={skill.name} title={<SkillName skill={skill} onOpen={setOpen} />} detail={skill.description} side={<Chip icon="box">Retired</Chip>} />)}</Rows></Section>}
 </div>)}</ReadState>;
}
