import { useQueryClient } from "@tanstack/react-query";
import { skillsKey } from "../../api/skills.js";
import type { ReactNode } from "react";
import { Button } from "../../design/Button.js";
import { SkillActions } from "../project/skills/SkillActions.js";
import "../project/skills/skills.css";
import { useRefreshScope } from "./hold.js";
import { SkillReader, useRead, useScope } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { Card, Chip, Header, RailCard, Two } from "./parts.js";
import { approvals, type Skill } from "./SkillsReadScreen.js";

const needsReview = (skill: Skill) => !skill.retired && skill.activeVersion !== skill.currentVersion;
function detailMeta(skill: Skill) {
 return "Skill · " + (skill.retired ? "retired" : skill.activeVersion === undefined ? "not in use yet" : "version " + String(skill.activeVersion) + " in use") + (needsReview(skill) ? " · version " + String(skill.currentVersion) + " waiting" : "");
}
function SkillSnapshot({ skill, actions }: { skill: Skill & { content: string }; actions?: ReactNode }) {
 const name = skill.name, waiting = needsReview(skill);
 return <Two rail={<RailCard title="Versions"><ul className="rv-wsr-versions">
  <li><span className="rv-wsr-vicon" data-tone={waiting ? "attention" : "ok"} aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{waiting ? <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></> : <path d="m3 8 3 3 7-7" />}</svg></span><strong>{"Version " + String(skill.currentVersion) + " · newest"}</strong><span>{approvals(skill)}</span></li>
  {skill.activeVersion !== undefined && skill.activeVersion !== skill.currentVersion && <li><span className="rv-wsr-vicon" data-tone="ok" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7" /></svg></span><strong>{"Version " + String(skill.activeVersion) + " · in use"}</strong><span>Tasks started now use this version</span></li>}
 </ul><p>Decision history: Can&apos;t tell yet.</p></RailCard>}>
  <div className="rv-wsr-head"><div className="rv-wsr-title"><h2>{name}</h2>{skill.retired ? <Chip icon="box">Retired</Chip> : waiting ? <Chip tone="attention">New version to review</Chip> : <Chip tone="ok">In use</Chip>}</div><p className="rv-wsr-lede">{skill.description}</p></div>
  {waiting && skill.activeVersion !== undefined && <Card level={3} title={"Version " + String(skill.activeVersion) + " · in use"}><p className="rv-wsr-quiet">Text of this version: Can&apos;t tell yet.</p></Card>}
  <Card {...(waiting ? { tone: "attention" as const } : {})} level={3} title={"Version " + String(skill.currentVersion) + " · newest"}><pre aria-label={name + " text"}>{skill.content}</pre></Card>
  {actions}
 </Two>;
}

/** The list supplies the lookup name; all displayed facts belong to the returned detail snapshot. */
export function SkillDetailReadPanel({ skill, onBack, canDecide = false }: { skill: Skill; onBack: () => void; /** Code's say-so on the (current) list read; the detail read says it again. */ canDecide?: boolean }) {
 const scope = useScope(), { project } = scope, name = skill.name, query = useQueryClient(), refreshScope = useRefreshScope(scope.key);
 const refresh = () => { void refreshScope(); void query.invalidateQueries({ queryKey: skillsKey(project) }); };
 const read = useRead("skill:" + name, "skills/" + encodeURIComponent(name), { parse(raw: unknown) { const value = SkillReader.parse(raw); if (value.skill.name !== name) throw new Error("Wrong skill"); return value; } }, true, true);
 return <ReadState read={read} label="this skill" code="WIKI-SKILL-READ-FAILED" notFound="That skill is no longer there." header={(confirmed, readAt) => <><Header project={project} trail={["Skills", name]} {...(confirmed && read.data !== undefined ? { meta: detailMeta(read.data.skill), readAt } : {})} /><div className="rv-wsr-back"><Button variant="quiet" onClick={onBack}>Back to Skills</Button></div></>}>{read.data !== undefined && <SkillSnapshot skill={read.data.skill} actions={<div className="rv-wsr-skillactions"><SkillActions project={project} skill={read.data.skill} may={canDecide && read.data.canDecide && !read.isError && read.failureCount === 0} refresh={refresh} /></div>} />}</ReadState>;
}
