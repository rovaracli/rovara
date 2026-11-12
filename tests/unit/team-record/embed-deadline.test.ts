// L2 (DECISIONS 140): the end of an SQS batch reaches every embedding call made inside it, and only those.
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_EMBEDDER } from "@agentx/cloud-contracts";
import { createEmbedderClient, type EmbedderClient } from "../../../packages/broker/src/embedder/client.js";
import { createEmbedder } from "../../../packages/broker/src/team-record/embed.js";
import { embedDeadlineInScope, runWithEmbedDeadline, withEmbedDeadline } from "../../../packages/broker/src/team-record/embed-deadline.js";

const unit = (): number[] => Array.from({ length: TEAM_RECORD_EMBEDDER.dimension }, () => 1 / Math.sqrt(TEAM_RECORD_EMBEDDER.dimension));
const reply = (count: number) => ({ ok: true, model: "record", modelId: TEAM_RECORD_EMBEDDER.modelId, revision: TEAM_RECORD_EMBEDDER.revision, spec: TEAM_RECORD_EMBEDDER.spec, dimension: TEAM_RECORD_EMBEDDER.dimension, vectors: Array.from({ length: count }, unit), truncated: Array.from({ length: count }, () => false) });

function clientRecording(clock: { ms: number }): { client: EmbedderClient; limits: Array<number | undefined> } {
  const limits: Array<number | undefined> = [];
  const client = createEmbedderClient({ spec: TEAM_RECORD_EMBEDDER, now: () => clock.ms, invoke: async (request, limit) => { limits.push(limit?.timeoutMs); return reply(request.texts.length); } });
  return { client, limits };
}

describe("the embedding deadline of a drain", () => {
  it("caps the client's wait at what is left of the deadline, for a single text and for a batch", async () => {
    const clock = { ms: 1_000_000 };
    const { client, limits } = clientRecording(clock);
    const embedder = withEmbedDeadline(createEmbedder({ client }));
    await runWithEmbedDeadline(clock.ms + 4_000, async () => {
      await embedder.embed("one");
      await embedder.embedWithInfo("two", "document");
      await embedder.embedManyWithInfo(["three", "four"], "document");
    });
    expect(limits).toEqual([4_000, 4_000, 4_000]);
  });

  it("sends nothing at all once the deadline has passed, and the failure is the fixed 'deadline' one (the row keeps embedPending)", async () => {
    const clock = { ms: 1_000_000 };
    const { client, limits } = clientRecording(clock);
    const embedder = withEmbedDeadline(createEmbedder({ client }));
    const error = await runWithEmbedDeadline(clock.ms - 1, () => embedder.embed("late")).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "EmbedUnavailableError", timing: "deadline", reason: "UNREACHABLE" });
    expect(limits).toEqual([]);
  });

  it("the earlier of the call's own deadline and the drain's wins; outside a drain the call is unchanged", async () => {
    const clock = { ms: 1_000_000 };
    const { client, limits } = clientRecording(clock);
    const embedder = withEmbedDeadline(createEmbedder({ client }));
    await runWithEmbedDeadline(clock.ms + 4_000, () => embedder.embedWithInfo("a", "document", { deadline: clock.ms + 1_500 }));
    await runWithEmbedDeadline(clock.ms + 1_000, () => embedder.embedWithInfo("b", "document", { deadline: clock.ms + 9_000 }));
    expect(limits).toEqual([1_500, 1_000]);
    expect(embedDeadlineInScope()).toBeUndefined();
    await embedder.embed("c");
    await embedder.embedWithInfo("d", "document", { deadline: clock.ms + 2_000 });
    expect(limits).toEqual([1_500, 1_000, undefined, 2_000]);
  });

  it("two drains running at once each keep their own deadline", async () => {
    const clock = { ms: 1_000_000 };
    const { client, limits } = clientRecording(clock);
    const embedder = withEmbedDeadline(createEmbedder({ client }));
    await Promise.all([
      runWithEmbedDeadline(clock.ms + 3_000, async () => { await Promise.resolve(); await embedder.embed("a"); }),
      runWithEmbedDeadline(clock.ms + 7_000, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); await embedder.embed("b"); }),
    ]);
    expect(limits.sort()).toEqual([3_000, 7_000]);
  });
});
