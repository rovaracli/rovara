// OWNER-RUN, REAL Bedrock calls (staging us-west-2). Never imported by tests; the tests use fakes. ROVARA-AI-REASONING-CARRYOVER.
//
// One two-turn tool loop per model, through the gateway's OWN translation and transport (toConverse, createBedrockTransport,
// ConverseStreamToSse), so what this proves is what the gateway will do:
//   turn 1: "Call the ping tool." with one tool, maxTokens 256        -> the model answers with a tool call (and its reasoning, if any)
//   turn 2: the whole history (the answer of turn 1 INCLUDING its reasoning as a `thinking` block) + the tool result "pong", maxTokens 256
//           -> the model must accept it and answer to the end (a model that wants its reasoning back would refuse otherwise)
// Control (on by default; RR_CONTROL=0 turns it off): a third call per model, turn 2 WITHOUT the reasoning. "pass" alone cannot tell "the model used the
// reasoning" from "Bedrock ignored the field": read controlWithoutReasoning beside it (a refusal there, and a pass above, shows the reasoning is needed and works).
// A model PASSES when both turns end normally (HTTP 200, a complete stream, usage) and turn 1 made a tool call. Nothing else is judged here:
// read the printed line for the model, then decide whether to list it (agent-ai.ts) in a separate change.
//
// Cost: at most 3 calls per model (2 with RR_CONTROL=0), maxTokens 256 each, history under 1 KB. A running total of tokens is kept and the run STOPS
// before the next call once it is over 7,000 input or 1,000 output tokens in all (that is about $0.05 even at $5 / $15 per million tokens, and these
// models cost a fraction of that: expect well under one cent; a model skipped for the budget is printed as skipped, run it alone). No secret is printed; credentials are read from the AWS CLI's profile as set by staging-aws.sh and never written.
//
// Run (from this worktree, after `npm ci` / the dist build):
//   ~/.local/share/rovara-tools/staging-aws.sh env ROVARA_REASONING_TWO_TURN=1 RR_OUT=/tmp/rr-two-turn \
//     node_modules/.bin/tsx scripts/bedrock-reasoning-two-turn.ts deepseek.v3.2 moonshot.kimi-k2-thinking minimax.minimax-m2.5 us.moonshotai.kimi-k3 us.moonshotai.kimi-k3.1
// RR_OUT (optional): a folder that gets each raw answer as <model>.turn1.json / .turn2.json (the SSE the gateway would give the agent), to turn into fixtures.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { BEDROCK_CONVERSE_ID, REASONING_CARRYOVER_MODEL, toConverse } from "../packages/model-gateway/src/bedrock-converse.js";
import { bedrockConversePath, createBedrockTransport } from "../packages/model-gateway/src/bedrock-transport.js";
import type { AwsCredentials } from "../packages/model-gateway/src/aws.js";

const REGION = "us-west-2";
const MAX_TOKENS = 256;
const INPUT_BUDGET = 7_000; const OUTPUT_BUDGET = 1_000;
const TOOLS = [{ name: "ping", description: "Ping.", input_schema: { type: "object", properties: {} } }];
const FIRST = { role: "user", content: "Call the ping tool." };

if (process.env.ROVARA_REASONING_TWO_TURN !== "1") { console.error("refused: set ROVARA_REASONING_TWO_TURN=1 (this makes real, billed Bedrock calls)"); process.exit(2); }
if ((process.env.AWS_REGION ?? "") !== REGION) { console.error(`refused: AWS_REGION must be ${REGION} (run it through ~/.local/share/rovara-tools/staging-aws.sh)`); process.exit(2); }
const models = process.argv.slice(2);
if (models.length === 0 || models.length > 5) { console.error("usage: bedrock-reasoning-two-turn.ts <model id> ... (1 to 5)"); process.exit(2); }
for (const id of models) if (!REASONING_CARRYOVER_MODEL.test(id) || !BEDROCK_CONVERSE_ID.test(id)) { console.error(`refused: ${id} is not one of the five reasoning models`); process.exit(2); }
const out = process.env.RR_OUT;
if (out !== undefined && out !== "") mkdirSync(out, { recursive: true });

/** The profile's credentials, read once from the AWS CLI (a local read; no AWS request), kept in memory only. */
function credentials(): AwsCredentials {
  const raw = JSON.parse(execFileSync("aws", ["configure", "export-credentials", "--format", "process"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
  return { accessKeyId: raw.AccessKeyId, secretAccessKey: raw.SecretAccessKey, ...(raw.SessionToken === undefined ? {} : { sessionToken: raw.SessionToken }) };
}
const creds = credentials();
const transport = createBedrockTransport({ region: REGION, credentials: async () => creds });

type Json = Record<string, unknown>;
let inputTokens = 0; let outputTokens = 0;
interface Turn { status: number; stop?: string; blocks: Json[]; usage?: { input: number; output: number }; error?: string; complete: boolean }

/** One call: the Anthropic body through the gateway's own toConverse and transport; the answer as the Anthropic blocks the agent would get. */
async function turn(model: string, messages: Json[]): Promise<Turn> {
  const converse = toConverse({ messages, tools: TOOLS }, MAX_TOKENS, REASONING_CARRYOVER_MODEL.test(model));
  if (converse === undefined) return { status: 0, blocks: [], complete: false, error: "the gateway would refuse this request (toConverse returned nothing)" };
  const signal = AbortSignal.timeout(90_000);
  const response = await transport({ body: Buffer.from(JSON.stringify(converse)), headers: {}, key: "", signal, path: bedrockConversePath(model, true) });
  const chunks: Buffer[] = []; for await (const c of response.body) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString("utf8");
  if (response.status !== 200) return { status: response.status, blocks: [], complete: false, error: text.replace(/\d{12}/gu, "<acct>").slice(0, 200) };
  const events = text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n")[1]!.replace(/^data: /u, "")) as Json & { type: string; index?: number; delta?: Json; content_block?: Json; usage?: Json });
  const blocks: Json[] = []; let stop: string | undefined; let usage: Turn["usage"]; let ended = false;
  for (const e of events) {
    if (e.type === "content_block_start") blocks[e.index!] = { ...e.content_block! };
    else if (e.type === "content_block_delta") {
      const b = blocks[e.index!]!; const d = e.delta!;
      if (d.type === "text_delta") b.text = `${b.text as string}${d.text as string}`;
      else if (d.type === "thinking_delta") b.thinking = `${b.thinking as string}${d.thinking as string}`;
      else if (d.type === "signature_delta") b.signature = `${b.signature as string}${d.signature as string}`;
      else if (d.type === "input_json_delta") b.partial = `${(b.partial as string | undefined) ?? ""}${d.partial_json as string}`;
    } else if (e.type === "message_delta") { stop = (e.delta as { stop_reason?: string }).stop_reason; const u = e.usage as { input_tokens: number; output_tokens: number }; usage = { input: u.input_tokens, output: u.output_tokens }; }
    else if (e.type === "message_stop") ended = true;
  }
  const done = blocks.map((b) => { if (b.type !== "tool_use") return b; const { partial, ...rest } = b; return { ...rest, input: JSON.parse((partial as string | undefined) ?? "{}") as Json }; });
  if (usage !== undefined) { inputTokens += usage.input; outputTokens += usage.output; }
  return { status: 200, ...(stop === undefined ? {} : { stop }), blocks: done, ...(usage === undefined ? {} : { usage }), complete: ended && usage !== undefined };
}
const over = () => inputTokens > INPUT_BUDGET || outputTokens > OUTPUT_BUDGET;
const save = (model: string, name: string, value: unknown) => { if (out !== undefined && out !== "") writeFileSync(`${out}/${model.replace(/[^a-z0-9.-]/giu, "_")}.${name}.json`, JSON.stringify(value, null, 1)); };

let failed = false;
for (const model of models) {
  const line: Json = { model };
  if (over()) { line.skipped = "token budget reached"; console.log(JSON.stringify(line)); failed = true; continue; }
  try {
    const one = await turn(model, [FIRST]);
    save(model, "turn1", one);
    const tool = one.blocks.find((b) => b.type === "tool_use") as { id: string; name: string } | undefined;
    const thinking = one.blocks.filter((b) => b.type === "thinking") as Array<{ thinking: string; signature: string }>;
    line.turn1 = { status: one.status, stop: one.stop, complete: one.complete, toolCall: tool?.name ?? null, thinkingBlocks: thinking.length, thinkingChars: thinking.reduce((n, b) => n + b.thinking.length, 0), signed: thinking.some((b) => b.signature !== ""), usage: one.usage, ...(one.error === undefined ? {} : { error: one.error }) };
    if (!one.complete || tool === undefined || over()) { line.pass = false; failed = true; console.log(JSON.stringify(line)); continue; }
    const history = [FIRST, { role: "assistant", content: one.blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "pong" }] }];
    const two = await turn(model, history);
    save(model, "turn2", two);
    const text = two.blocks.filter((b) => b.type === "text").map((b) => b.text as string).join("");
    line.turn2 = { status: two.status, stop: two.stop, complete: two.complete, textChars: text.length, toolCalls: two.blocks.filter((b) => b.type === "tool_use").length, rawToolMarkup: /DSML|<tool_call>|<\|tool/u.test(text), usage: two.usage, ...(two.error === undefined ? {} : { error: two.error }) };
    line.pass = two.complete && two.status === 200;
    if (process.env.RR_CONTROL !== "0" && !over()) {
      const bare = await turn(model, [FIRST, { role: "assistant", content: one.blocks.filter((b) => b.type !== "thinking") }, history[2]!]);
      line.controlWithoutReasoning = { status: bare.status, stop: bare.stop, complete: bare.complete, ...(bare.error === undefined ? {} : { error: bare.error }) };
    }
    if (line.pass !== true) failed = true;
  } catch (error) { line.pass = false; line.error = String(error).replace(/\d{12}/gu, "<acct>").slice(0, 160); failed = true; }
  console.log(JSON.stringify(line));
}
console.log(JSON.stringify({ summary: true, region: REGION, totalInputTokens: inputTokens, totalOutputTokens: outputTokens, allPassed: !failed }));
process.exit(failed ? 1 : 0);
