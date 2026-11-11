// Plan 3 Task 9: the org's skills registry. A skill is a SKILL.md (the Agent Skills format) with a name and a description in its front
// matter. Its content is stored as immutable versions keyed by the SHA-256 digest of the content, so an agent version can pin the exact
// text it was published with (`SkillRef.digest`) and a later edit of the skill changes nothing that is already published. Every key is
// under the org, so one org's skill id means nothing to another. Who may create or change a skill is decided by the routes (routes.ts).
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { newPrefixedId, orgScoped, skillDirectoryKey, skillKey, skillNameKey, type AgentOwner, type OrgId, type OrgKey, type RecipeProblem, type ResolvedRecipe, type ResolvedSkill, type SkillId, type SkillRef } from "@rovara-code/contracts";
import { coded, commit, errorName, putNew, strip, updateItem, type Item, type RequestMark, type TableInput, type TransactItem } from "./table-writes.js";

/**
 * The longest SKILL.md, in UTF-8 bytes. It is below the 64 KiB an agent step's instructions may hold (`AGENT_STEP_INSTRUCTIONS_MAX_BYTES`), so
 * any one skill can always be read into a step, and the 20 skills a recipe may list fit in a step's payload as names and descriptions.
 */
export const SKILL_CONTENT_MAX_BYTES = 32_768;
export const SKILL_DESCRIPTION_MAX = 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** One `key: value` line of the front matter; anything indented, a list item or a comment doesn't match. */
const FRONT_MATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/;
/** A plain value a YAML parser would read as something other than text: a number, true, false or null. */
const YAML_TYPED = /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|nan)|true|false|null|~)$/i;
const ALLOWED_KEYS = ["name", "description"] as const;

export interface SkillRecord {
  orgId: OrgId;
  skillId: SkillId;
  /** From the front matter; it never changes. */
  name: string;
  /** From the current content's front matter. */
  description: string;
  owner: AgentOwner;
  currentDigest: string;
  createdAt: string;
  updatedAt: string;
}

/** One immutable version of a skill, at `VERSION#<digest>`. */
export interface SkillVersion {
  digest: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

/** The SHA-256 of the content as UTF-8, lower-case hex: the digest an agent version pins and the worker checks. */
export function skillDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const invalid = (message: string) => coded("CONFIG_INVALID", `content: ${message}`);

function scalar(key: string, raw: string, line: number): string {
  const refuse = () => invalid(`front matter line ${String(line)}: write the ${key} as plain text or in quotes`);
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) throw refuse();
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "string") throw refuse();
      return value;
    } catch {
      throw refuse();
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) throw refuse();
    const inner = raw.slice(1, -1);
    if (inner.replace(/''/g, "").includes("'")) throw refuse();
    return inner.replace(/''/g, "'");
  }
  // Characters that start YAML syntax we do not read: block scalars, lists, maps, anchors, tags and comments.
  if (/^[>|[\]{}&*!%@`#]/.test(raw)) throw refuse();
  // A plain value must read the same in a YAML parser as here: the same text, not a number, a boolean, a comment or a nested key.
  const quote = (reason: string) => invalid(`front matter line ${String(line)}: put the ${key} in quotes, because YAML would read it as ${reason}`);
  if (YAML_TYPED.test(raw)) throw quote("a number, true, false or null");
  if (/(^|[ \t])#/.test(raw)) throw quote("the start of a comment");
  if (/:([ \t]|$)/.test(raw)) throw quote("a key with a value");
  return raw;
}

/**
 * The name and description of a SKILL.md. The file starts with a front matter block between two `---` lines that holds `name` and
 * `description` as single-line values, plain or quoted, and no other key (a key such as `allowed-tools` would change what the agent may
 * do, which only the recipe decides). A file that is not that, or is over 32,768 bytes, is `CONFIG_INVALID`.
 */
export function parseSkillMarkdown(content: unknown): { name: string; description: string } {
  if (typeof content !== "string" || content.trim() === "") throw invalid("a skill needs a SKILL.md");
  if (Buffer.byteLength(content, "utf8") > SKILL_CONTENT_MAX_BYTES) throw invalid(`a skill is at most ${String(SKILL_CONTENT_MAX_BYTES)} bytes`);
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") throw invalid("SKILL.md must start with a front matter block between two --- lines");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw invalid("the front matter has no closing --- line");

  const found: Array<{ key: string; raw: string; line: number }> = [];
  for (let index = 1; index < close; index += 1) {
    const text = lines[index] ?? "";
    if (text.trim() === "") continue;
    // YAML reads U+0085 as a line break, so a parser would see a second line where this sees one.
    if (text.includes("\u0085")) throw invalid(`front matter line ${String(index + 1)} contains U+0085, which YAML reads as a line break`);
    const matched = FRONT_MATTER_LINE.exec(text);
    if (matched === null) throw invalid(`front matter line ${String(index + 1)} isn't "key: value" (nested values, lists, comments and values over several lines aren't allowed)`);
    found.push({ key: matched[1]!, raw: matched[2] ?? "", line: index + 1 });
  }
  const values = new Map<string, string>();
  for (const { key, raw, line } of found) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) throw invalid(`front matter key "${key}" isn't allowed; only name and description are`);
    if (values.has(key)) throw invalid(`front matter key "${key}" appears twice`);
    values.set(key, scalar(key, raw, line));
  }
  const name = values.get("name");
  const description = values.get("description");
  if (name === undefined) throw invalid("the front matter needs a name");
  if (description === undefined) throw invalid("the front matter needs a description");
  if (!NAME_PATTERN.test(name)) throw invalid("name must be 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit");
  // Counted in characters (code points), as people count them; `ResolvedRecipeSchema` and the worker count the same way.
  const characters = [...description].length;
  if (characters < 1 || characters > SKILL_DESCRIPTION_MAX) throw invalid(`description must be 1 to ${String(SKILL_DESCRIPTION_MAX)} characters`);
  return { name, description };
}

export interface SkillStoreInput extends TableInput {
  newId?: () => SkillId;
}

const unknownSkill = () => coded("CONFIG_INVALID", "skills: unknown skill");
const skillConflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this skill. Reload it and make your change again.");

export class SkillStore {
  private readonly newId: () => SkillId;

  constructor(private readonly input: SkillStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("skl"));
  }

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  private async read(key: OrgKey): Promise<Item | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    return response.Item;
  }

  // ---- reads

  async get(orgId: OrgId, skillId: SkillId): Promise<SkillRecord | undefined> {
    const item = await this.read(skillKey(orgId, skillId, "META"));
    return item === undefined ? undefined : (strip(item) as unknown as SkillRecord);
  }

  async getVersion(orgId: OrgId, skillId: SkillId, digest: string): Promise<SkillVersion | undefined> {
    if (!SHA256_HEX.test(digest)) return undefined;
    const item = await this.read(skillKey(orgId, skillId, `VERSION#${digest}`));
    return item === undefined ? undefined : (strip(item) as unknown as SkillVersion);
  }

  /** The org's skills, in the order of their ids. */
  async list(orgId: OrgId): Promise<SkillRecord[]> {
    const directory: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": orgScoped(orgId, "SKILL_DIRECTORY") },
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      directory.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    const skills = await Promise.all(directory.map((entry) => this.get(orgId, entry["sk"] as SkillId)));
    return skills.filter((skill): skill is SkillRecord => skill !== undefined);
  }

  /**
   * A reference as a recipe lists it: the skill's name, its description at that content and the digest. A reference without a digest
   * takes the skill's current content; one with a digest takes exactly that version. A skill or digest the org does not have is
   * `skills: unknown skill`.
   */
  async resolve(orgId: OrgId, ref: SkillRef): Promise<ResolvedSkill> {
    const digest = ref.digest ?? (await this.get(orgId, ref.skillId))?.currentDigest;
    const version = digest === undefined ? undefined : await this.getVersion(orgId, ref.skillId, digest);
    if (digest === undefined || version === undefined) throw unknownSkill();
    const { name, description } = parseSkillMarkdown(version.content);
    return { skillId: ref.skillId, name, description, digest };
  }

  /** Refuses, as `skills: unknown skill`, any reference the org does not have, and a skill listed twice. */
  async requireRefs(orgId: OrgId, refs: readonly SkillRef[] | undefined): Promise<void> {
    // One skill once: a recipe lists it once, and the publish transaction can touch a skill's item only once.
    if (new Set((refs ?? []).map((ref) => ref.skillId)).size !== (refs ?? []).length) throw coded("CONFIG_INVALID", "skills.add: a skill is listed twice");
    await Promise.all((refs ?? []).map((ref) => this.resolve(orgId, ref)));
  }

  /**
   * The references with every one pinned to a digest, and the transaction items that keep the unpinned ones true: a reference without a
   * digest takes `expected[skillId]` (the digest the caller's recipe was resolved with) or else the skill's current one, and the write
   * applies only while the skill still has that current content.
   */
  async pin(orgId: OrgId, refs: readonly SkillRef[], expected: Readonly<Record<string, string>> = {}): Promise<{ refs: SkillRef[]; checks: TransactItem[] }> {
    const pinned: SkillRef[] = [];
    const checks: TransactItem[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      // A skill listed twice (a draft saved before that was refused) is pinned once: the transaction may check an item only once.
      if (seen.has(ref.skillId)) continue;
      seen.add(ref.skillId);
      const digest = ref.digest ?? expected[ref.skillId] ?? (await this.get(orgId, ref.skillId))?.currentDigest;
      if (digest === undefined) throw unknownSkill();
      await this.resolve(orgId, { skillId: ref.skillId, digest });
      pinned.push({ skillId: ref.skillId, digest });
      if (ref.digest === undefined) {
        checks.push({
          ConditionCheck: {
            TableName: this.input.tableName,
            Key: skillKey(orgId, ref.skillId, "META"),
            ConditionExpression: "currentDigest = :digest",
            ExpressionAttributeValues: { ":digest": digest },
          },
        });
      }
    }
    return { refs: pinned, checks };
  }

  // ---- writes

  /**
   * Creates a skill from its SKILL.md: the name and description come from the front matter (`name`, when given, must be the same), and the
   * name is unique in the org. One transaction writes the record, its first version, the directory item and the name item.
   */
  async create(input: { orgId: OrgId; content: string; name?: string; owner: AgentOwner; by: string; request?: RequestMark }): Promise<SkillRecord> {
    const { name, description } = parseSkillMarkdown(input.content);
    if (input.name !== undefined && input.name !== name) throw coded("CONFIG_INVALID", `name: the file says "${name}", not "${input.name}"`);
    const skillId = this.newId();
    const digest = skillDigest(input.content);
    const now = this.iso();
    const record: SkillRecord = { orgId: input.orgId, skillId, name, description, owner: input.owner, currentDigest: digest, createdAt: now, updatedAt: now };
    const version: SkillVersion = { digest, content: input.content, createdBy: input.by, createdAt: now };
    await commit(this.input, [
      putNew(this.input, skillKey(input.orgId, skillId, "META"), "SKILL", record as unknown as Item),
      putNew(this.input, skillKey(input.orgId, skillId, `VERSION#${digest}`), "SKILL_VERSION", version as unknown as Item),
      putNew(this.input, skillDirectoryKey(input.orgId, skillId), "SKILL_DIRECTORY", { skillId, createdAt: now }),
      putNew(this.input, skillNameKey(input.orgId, name), "SKILL_NAME", { skillId, createdAt: now }),
    ], (failed) => (failed.has(3) ? coded("CONFIG_INVALID", `name: another skill in your company is called ${name}`) : undefined), input.request, record);
    return record;
  }

  /**
   * Hands the skill from one owner to another (Rovara's own move after a member is removed or merged, Task 11). It applies only while the skill
   * still has the owner it was read with, so a repeat, or a skill someone else already moved, changes nothing. Answers whether it moved.
   */
  async moveOwner(orgId: OrgId, skillId: SkillId, from: AgentOwner, to: AgentOwner): Promise<boolean> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: skillKey(orgId, skillId, "META"),
        UpdateExpression: "SET #owner = :to",
        ConditionExpression: "attribute_exists(pk) AND #owner = :from",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":from": from, ":to": to },
      }));
      return true;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      return false;
    }
  }

  /**
   * Makes `content` the skill's current content, as a new version (an earlier version's content is restored without rewriting it). It
   * applies only while the current digest is `expectedDigest`, so of two edits made against the same content one wins and the other
   * conflicts. The front matter's name must be the skill's own.
   */
  async putContent(input: { orgId: OrgId; skillId: SkillId; content: string; expectedDigest: string; by: string; request?: RequestMark }): Promise<SkillRecord> {
    const record = await this.get(input.orgId, input.skillId);
    if (record === undefined) throw coded("NOT_FOUND", "no skill has that ID");
    const { name, description } = parseSkillMarkdown(input.content);
    if (name !== record.name) throw invalid(`the name is "${name}" but this skill is called "${record.name}"; a skill's name never changes`);
    const digest = skillDigest(input.content);
    const updatedAt = this.iso();
    const existing = await this.getVersion(input.orgId, input.skillId, digest);
    const updated: SkillRecord = { ...record, description, currentDigest: digest, updatedAt };
    const items: TransactItem[] = [
      updateItem(this.input, skillKey(input.orgId, input.skillId, "META"), {
        set: { currentDigest: digest, description, updatedAt },
        when: (a) => `${a.name("currentDigest")} = ${a.value(input.expectedDigest)}`,
      }),
    ];
    if (existing === undefined) {
      const version: SkillVersion = { digest, content: input.content, createdBy: input.by, createdAt: updatedAt };
      items.push(putNew(this.input, skillKey(input.orgId, input.skillId, `VERSION#${digest}`), "SKILL_VERSION", version as unknown as Item));
    }
    await commit(this.input, items, () => skillConflict(), input.request, updated);
    return updated;
  }
}

/**
 * The problems a recipe has with its skills in this org: a skill, or the digest it is pinned to, that the org does not have
 * (`skills.<n>: unknown skill`). A recipe that came from `resolveAgent` has none unless the resolver was replaced.
 */
export async function skillProblems(table: TableInput, orgId: OrgId, recipe: Pick<ResolvedRecipe, "skills">): Promise<RecipeProblem[]> {
  const store = new SkillStore(table);
  const problems: RecipeProblem[] = [];
  await Promise.all(recipe.skills.map(async (skill, index) => {
    if (await store.getVersion(orgId, skill.skillId, skill.digest) === undefined) problems.push({ path: `skills.${String(index)}`, message: "unknown skill" });
  }));
  return problems.sort((left, right) => left.path.localeCompare(right.path, "en", { numeric: true }));
}

/**
 * The contents a step reads (`GET /v1/internal/agent-skills`): for each skill of a task's recipe snapshot, the version it was pinned to.
 * Read under `orgId`, so a snapshot can never reach another org's skill. A stored content that does not hash to its digest is an error,
 * not something to serve.
 */
export async function servedSkills(store: SkillStore, orgId: OrgId, skills: ReadonlyArray<Pick<ResolvedSkill, "skillId" | "digest">>): Promise<Array<{ name: string; description: string; digest: string; content: string }>> {
  return Promise.all(skills.map(async ({ skillId, digest }) => {
    const version = await store.getVersion(orgId, skillId, digest);
    if (version === undefined || skillDigest(version.content) !== digest) throw coded("RUNTIME_UNAVAILABLE", "a skill of this agent can't be read as it was published");
    const { name, description } = parseSkillMarkdown(version.content);
    return { name, description, digest, content: version.content };
  }));
}
