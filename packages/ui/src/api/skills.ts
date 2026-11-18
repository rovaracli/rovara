// L4-JA (journey audit B11): the project's Skills screen, on Code's skills routes through Cloud (contract v0 `skills.*`). A skill is a procedure the team proved, kept as versions; a version is used only after TWO different
// people who may decide have approved it. Code decides who (a maintainer of the project, or a company owner or admin, said by `canDecide`), the 32 KB limit and the audit; the screen only draws the buttons for people Code says may
// use them and shows Code's own refusal sentences. Nothing here asks for a step-up. Every write is sent once (`retry: "never"`).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SkillDetail, SkillEditRequest, SkillForm, SkillRow } from "@agentx/contracts/code-contract-v0";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type Reader } from "./client.js";
import { ApiError } from "./errors.js";

export type { SkillDetail, SkillForm, SkillRow };
const NEVER = { retry: "never" } as const;

// ---- Limits (Code's, repeated: the screen cannot import them) and words ----
export const SKILL_LIMITS = { description: 200, when: 2_000, step: 4_000, steps: 12, note: 2_000, textBytes: 32_768, longBytes: 8_192, approversRequired: 2 } as const;
export const SKILL_LONG_NOTE = "This skill is long. Consider splitting it into smaller skills.";
export const SKILLS_TAB = "Skills";
export const SKILLS_TITLE = "Skills";
export const SKILLS_INTRO = "A skill is a procedure your team proved. Rovara gives its text to agents at the steps where it fits. A skill grants no tools. Each version needs two different people to approve it before it is used.";
export const SKILLS_EMPTY_TITLE = "No skills yet";
export const SKILLS_EMPTY = "When a lesson has proved itself, a maintainer can make it a skill from its card in How we work. It appears here to be approved.";
export const SKILLS_READ_ONLY = "Only a maintainer of this project, or an admin, can approve, change or retire skills.";
export const SKILLS_LOAD_FAILED = "Couldn't load the skills. Try again.";
export const SKILL_LOAD_FAILED = "Couldn't load this skill. Try again.";
export const SKILL_RETIRE_CONFIRM = "Retire this skill? Rovara stops giving it to tasks at once. Its versions are kept. You can't undo this here.";
export const SKILL_WRITE_FAILED = "That didn't go through. Nothing was changed.";
export const SKILL_STALE_WORDS = "This skill changed. It was read again; check it and decide again.";
export const NEEDS_TWO = "Needs two different people to approve it.";

/** Where a skill stands, in words. `retired` first, then in use / a draft / a newer draft beside the version in use. */
export function skillStatus(skill: Pick<SkillRow, "currentVersion" | "activeVersion" | "retired">): string {
  if (skill.retired) return "Retired";
  if (skill.activeVersion === undefined) return `Draft (version ${String(skill.currentVersion)}), not in use yet`;
  if (skill.activeVersion === skill.currentVersion) return `In use (version ${String(skill.currentVersion)})`;
  return `Version ${String(skill.activeVersion)} is in use; version ${String(skill.currentVersion)} is a draft`;
}
/** Whether the newest version is waiting for approvals (not in use, not retired). */
export const waitingForApproval = (skill: Pick<SkillRow, "currentVersion" | "activeVersion" | "retired">): boolean => !skill.retired && skill.activeVersion !== skill.currentVersion;
/** The approvals the newest version has, in words: "1 of 2 approvals". */
export const approvalWords = (skill: Pick<SkillRow, "approvals">): string => `${String(Math.min(skill.approvals, SKILL_LIMITS.approversRequired))} of ${String(SKILL_LIMITS.approversRequired)} approvals`;
/** What the person's own part is, for a version waiting for approval. */
export function approveHint(skill: Pick<SkillRow, "approvedByYou" | "approvals">): string {
  if (skill.approvedByYou) return skill.approvals >= SKILL_LIMITS.approversRequired ? "You approved this version." : "You approved this version. It needs one more person, not you again.";
  return skill.approvals === 0 ? NEEDS_TWO : "It needs one more person to approve it.";
}
export const sizeWords = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB of ${String(SKILL_LIMITS.textBytes / 1024)} KB`;
/** What a save came to, in words. */
export const savedWords = (version: number): string => `Saved as version ${String(version)}. ${NEEDS_TWO} The version in use, if there is one, stays in use until then.`;
export const approvedWords = (answer: { approvals: number; live: boolean }): string => (answer.live ? "Approved. This version is now in use." : `Approved. ${approvalWords(answer)}. It needs one more person before it is used.`);

/**
 * About how many bytes the skill's text will be once Code writes it (the same layout: front matter, when to use it, numbered steps, done when, why). A person sees the size while they write; Code makes the real count and
 * refuses a skill over 32 KB, so this only warns early.
 */
export function estimateSkillBytes(name: string, form: Omit<SkillForm, "steps"> & { steps: readonly string[] }): number {
  const one = (text: string) => text.trim().replace(/\s*\n\s*/gu, " ");
  const steps = form.steps.map(one).filter((step) => step !== "");
  const parts = ["---", `name: ${name}`, `description: ${one(form.description)}`, "---", "", "## When to use", one(form.when), "", "## Steps", ...steps.map((step, index) => `${String(index + 1)}. ${step}`), ""];
  if (one(form.doneWhen ?? "") !== "") parts.push("## Done when", one(form.doneWhen ?? ""), "");
  if (one(form.why ?? "") !== "") parts.push("## Why this order", one(form.why ?? ""), "");
  return new TextEncoder().encode(parts.join("\n")).length;
}

// ---- Readers: an answer that is not the shape is "unreadable", never half drawn ----
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const whole = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= 1_000_000_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function readRow(raw: unknown): SkillRow | undefined {
  if (!isRecord(raw) || !str(raw["name"]) || !NAME.test(raw["name"]) || !str(raw["description"]) || !whole(raw["currentVersion"], 1) || !whole(raw["approvals"]) || typeof raw["approvedByYou"] !== "boolean" || typeof raw["retired"] !== "boolean" || !whole(raw["bytes"])) return undefined;
  if (raw["activeVersion"] !== undefined && (!whole(raw["activeVersion"], 1) || raw["activeVersion"] > raw["currentVersion"])) return undefined;
  return {
    name: raw["name"], description: raw["description"], currentVersion: raw["currentVersion"], ...(raw["activeVersion"] === undefined ? {} : { activeVersion: raw["activeVersion"] }), approvals: raw["approvals"], approvedByYou: raw["approvedByYou"],
    retired: raw["retired"], bytes: raw["bytes"], ...(raw["note"] === SKILL_LONG_NOTE ? { note: SKILL_LONG_NOTE } : {}),
  };
}
function readForm(raw: unknown): SkillForm | undefined {
  if (!isRecord(raw) || !str(raw["description"]) || !str(raw["when"]) || !Array.isArray(raw["steps"]) || raw["steps"].length < 1 || !raw["steps"].every(str)) return undefined;
  if ((raw["doneWhen"] !== undefined && !str(raw["doneWhen"])) || (raw["why"] !== undefined && !str(raw["why"]))) return undefined;
  return { description: raw["description"], when: raw["when"], steps: raw["steps"], ...(str(raw["doneWhen"]) ? { doneWhen: raw["doneWhen"] } : {}), ...(str(raw["why"]) ? { why: raw["why"] } : {}) };
}
export interface SkillsView { project: string; canDecide: boolean; skills: SkillRow[] }
export interface SkillView { project: string; canDecide: boolean; skill: SkillDetail }
export const SkillsReader: Reader<SkillsView> = { parse(body: unknown): SkillsView {
  if (!isRecord(body) || !str(body["project"]) || !Array.isArray(body["skills"])) throw new Error("not a skills answer");
  const seen = new Set<string>();
  const skills = body["skills"].flatMap((one) => { const row = readRow(one); if (row === undefined || seen.has(row.name)) return []; seen.add(row.name); return [row]; });
  return { project: body["project"], canDecide: body["canDecide"] === true, skills };
} };
export const SkillReader: Reader<SkillView> = { parse(body: unknown): SkillView {
  if (!isRecord(body) || !str(body["project"]) || !isRecord(body["skill"])) throw new Error("not a skill answer");
  const row = readRow(body["skill"]), content = body["skill"]["content"];
  if (row === undefined || !str(content) || content === "") throw new Error("not a skill");
  const form = readForm(body["skill"]["form"]);
  return { project: body["project"], canDecide: body["canDecide"] === true, skill: { ...row, content, ...(form === undefined ? {} : { form }) } };
} };
const EditedReader: Reader<{ version: number; note?: string }> = { parse(body: unknown) {
  if (!isRecord(body) || !whole(body["version"], 1)) throw new Error("not an edit answer");
  return { version: body["version"], ...(body["note"] === SKILL_LONG_NOTE ? { note: SKILL_LONG_NOTE } : {}) };
} };
const ApprovedReader: Reader<{ version: number; approvals: number; live: boolean }> = { parse(body: unknown) {
  if (!isRecord(body) || !whole(body["version"], 1) || !whole(body["approvals"]) || typeof body["live"] !== "boolean") throw new Error("not an approval answer");
  return { version: body["version"], approvals: body["approvals"], live: body["live"] };
} };
const RetiredReader: Reader<{ retired: true }> = { parse(body: unknown) { if (!isRecord(body) || body["retired"] !== true) throw new Error("not a retire answer"); return { retired: true }; } };

export function createSkillsApi(host: AppHost) {
  const api = createApiClient(host);
  const skills = (project: string) => "/v1/app/projects/" + encodeURIComponent(project) + "/skills";
  const one = (project: string, name: string) => skills(project) + "/" + encodeURIComponent(name);
  const settled = <T,>(result: Awaited<ReturnType<typeof api.send<T>>>): T => {
    if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
    return result.value;
  };
  return {
    list: (project: string) => api.get(skills(project), SkillsReader),
    read: (project: string, name: string) => api.get(one(project, name), SkillReader),
    async edit(project: string, name: string, input: SkillEditRequest) { return settled(await api.send("PUT", one(project, name), input, EditedReader, NEVER)); },
    async approve(project: string, name: string, version: number) { return settled(await api.send("POST", one(project, name) + "/approve", { version }, ApprovedReader, NEVER)); },
    async retire(project: string, name: string) { return settled(await api.send("POST", one(project, name) + "/retire", {}, RetiredReader, NEVER)); },
  };
}
export function useSkillsApi() { const host = useAppHost();return useMemo(() => createSkillsApi(host), [host]); }
export const skillsKey = (project: string) => ["skills", "project", project] as const;
export function useSkills(project: string, enabled = true) { const api = useSkillsApi();return useQuery({ queryKey: [...skillsKey(project), "list"], enabled, queryFn: () => api.list(project), staleTime: 60_000, retry: false }); }
export function useSkill(project: string, name: string, enabled = true) { const api = useSkillsApi();return useQuery({ queryKey: [...skillsKey(project), "one", name], enabled, queryFn: () => api.read(project, name), staleTime: 30_000, retry: false }); }
/**
 * Whether the project page offers the Skills tab: once the list has been read, or when it could not be read for a reason worth retrying. Not offered while Code does not serve the routes (501), the answer cannot be read, lessons are off or
 * the person has no skills to see (any 4xx).
 */
export const skillsOffered = (query: { isSuccess: boolean; isError: boolean; error: unknown }): boolean => query.isSuccess || (query.isError && !(query.error instanceof ApiError && (query.error.status === 501 || query.error.code === "INVALID_RESPONSE" || (query.error.status >= 400 && query.error.status < 500))));
/** A refusal's own words (Cloud's and Code's fixed sentences), else the fallback. */
export const skillFailureWords = (error: unknown, fallback: string): string => (error instanceof ApiError && error.status !== 502 && error.message !== "" ? error.message : fallback);
