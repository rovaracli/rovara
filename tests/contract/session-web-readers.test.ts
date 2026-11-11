import { expect, it } from "vitest";
import { AppOrgMembersResponseSchema, AppOrgMembersResponseReaderSchema } from "@agentx/cloud-contracts/web";
it("reads the existing org-member response without inventing identity metadata", () => { const body = { members: [{ developerId: "a".repeat(64), name: "Priya", role: "member", joinedAt: "2026-10-23T12:00:00.000Z", identities: ["cloud"] }] };expect(AppOrgMembersResponseSchema.parse(body)).toEqual(body);expect(AppOrgMembersResponseSchema.safeParse({ members: [{ ...body.members[0], cookie: "must-not-be-accepted" }] }).success).toBe(false);expect(AppOrgMembersResponseReaderSchema.parse({ members: [{ ...body.members[0], newerField: true }] }).members[0]?.name).toBe("Priya"); });

it("tries every known union variant before an enum's unknown fallback", async () => {
 const { AgentIdSchema, forwardReader } = await import("@agentx/cloud-contracts/web");
 const reader = forwardReader(AgentIdSchema), custom = "agt_aaaaaaaaaaaaaaaaaaaa";
 expect(reader.parse(custom)).toBe(custom);expect(reader.parse("rovara-code")).toBe("rovara-code");expect(reader.parse("future-builtin")).toBe("unknown");
 const { z } = await import("zod");
 const union = forwardReader(z.union([z.enum(["first"]), z.enum(["second"]), z.object({ kind: z.literal("record"), name: z.string() })]));
 expect(union.parse("second")).toBe("second");expect(union.parse("future")).toBe("unknown");expect(union.parse({ kind: "record", name: "kept", future: true })).toMatchObject({ future: true });
});
