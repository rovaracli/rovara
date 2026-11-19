import { expect, it } from "vitest";
import { AppOrgMembersResponseSchema, AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
it("reads the existing org-member response without inventing identity metadata", () => { const body = { members: [{ developerId: "a".repeat(64), name: "Priya", role: "member", joinedAt: "2026-10-23T12:00:00.000Z", identities: ["cloud"] }] };expect(AppOrgMembersResponseSchema.parse(body)).toEqual(body);expect(AppOrgMembersResponseSchema.safeParse({ members: [{ ...body.members[0], cookie: "must-not-be-accepted" }] }).success).toBe(false);expect(AppOrgMembersResponseReaderSchema.parse({ members: [{ ...body.members[0], newerField: true }] }).members[0]?.name).toBe("Priya"); });

it("tries every known union variant before an enum's unknown fallback", async () => {
 const { AgentIdSchema, forwardReader } = await import("@agentx/contracts/web");
 const reader = forwardReader(AgentIdSchema), custom = "agt_aaaaaaaaaaaaaaaaaaaa";
 expect(reader.parse(custom)).toBe(custom);expect(reader.parse("rovara-code")).toBe("rovara-code");expect(reader.parse("future-builtin")).toBe("unknown");
 const { z } = await import("zod");
 const union = forwardReader(z.union([z.enum(["first"]), z.enum(["second"]), z.object({ kind: z.literal("record"), name: z.string() })]));
 expect(union.parse("second")).toBe("second");expect(union.parse("future")).toBe("unknown");expect(union.parse({ kind: "record", name: "kept", future: true })).toMatchObject({ future: true });
});

it("reads a session tile without money while keeping stored summaries strict", async () => {
 const { SessionListReaderSchema, SessionTileReaderSchema } = await import("@agentx/contracts/web");
 const { SessionSummarySchema } = await import("../../packages/contracts/src/agent-sessions.js");
 const summary = { status: "running", needsPeople: [], pendingApprovals: 0, digest: "d", computedAt: "2026-11-19T00:00:00.000Z" };
 const tile = { contractVersion: 1, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", kind: "task", title: "Shared task", owner: { developerId: "a".repeat(64), name: "Priya" }, where: { kind: "cloud" }, level: "view", revision: 1, summary, createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z" };
 expect(SessionListReaderSchema.parse({ sessions: [tile] }).sessions[0]?.summary).not.toHaveProperty("costUsd");
 expect(SessionTileReaderSchema.parse(tile).summary).not.toHaveProperty("costUsd");
 expect(SessionSummarySchema.safeParse(summary).success).toBe(false);
 expect(SessionListReaderSchema.safeParse({ sessions: [{ ...tile, summary: { ...summary, pendingApprovals: -1 } }] }).success).toBe(false);
 for (const field of ["costUsd", "runLimitUsd", "stopAtUsd"]) {
  expect(SessionListReaderSchema.safeParse({ sessions: [{ ...tile, summary: { ...summary, [field]: -1 } }] }).success).toBe(false);
 }
});
