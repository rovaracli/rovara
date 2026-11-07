// UX-4b: lessons waiting for a person are a Home card for the people who decide that project's lessons (`lessons/home-source.ts`).
import { afterEach, describe, expect, it } from "vitest";
import { HomeCardSchema, type OrgId } from "@agentx/contracts";
import { lessonsHomeSource, setLessonsHomeReader, LESSON_HOME_PROJECTS_MAX } from "../../../packages/broker/src/lessons/home-source.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ME = "a".repeat(64);
const caller = { orgId: ORG, developerId: ME, orgRole: "member" } as never;
function deps(projects: Array<{ project: string; role: string }>) {
  return { origin: "https://cell.example/", now: () => Date.parse("2026-11-07T00:00:00.000Z"), approvals: { projectMembers: { projectsOf: async () => projects } } } as never;
}
afterEach(() => { setLessonsHomeReader(undefined); });

describe("the Lessons waiting card", () => {
  it("makes one card per maintained project with lessons waiting for this person, linking to the Lessons tab", async () => {
    const asked: string[] = [];
    setLessonsHomeReader(async (orgId, developerId, project) => { asked.push(`${orgId}/${developerId}/${project}`); return project === "web" ? { waiting: 2, at: "2026-11-06T00:00:00.000Z" } : { waiting: 0 }; });
    const cards = await lessonsHomeSource.list(deps([{ project: "web", role: "maintainer" }, { project: "api", role: "maintainer" }, { project: "docs", role: "viewer" }]), caller, {} as never);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "lesson_waiting", title: "Lessons waiting in \"web\"", reason: "2 lessons wait for a maintainer's OK in \"web\"", at: "2026-11-06T00:00:00.000Z", buttons: [{ label: "Review", action: "open", method: "GET", href: "https://cell.example/app/projects/web?tab=lessons" }] });
    expect(HomeCardSchema.safeParse(cards[0]).success).toBe(true);
    // Only projects this person maintains are read; a viewer's project is not.
    expect(asked.sort()).toEqual([`${ORG}/${ME}/api`, `${ORG}/${ME}/web`]);
    expect(cards[0]!.cardId).not.toContain("web");
  });

  it("makes no card without the reader (the team record or lessons off), and a reader that fails costs only that project", async () => {
    expect(await lessonsHomeSource.list(deps([{ project: "web", role: "maintainer" }]), caller, {} as never)).toEqual([]);
    setLessonsHomeReader(async (_o, _d, project) => { if (project === "api") throw new Error("down"); return { waiting: 1 }; });
    const cards = await lessonsHomeSource.list(deps([{ project: "web", role: "maintainer" }, { project: "api", role: "maintainer" }]), caller, {} as never);
    expect(cards.map((card) => card.title)).toEqual(["Lessons waiting in \"web\""]);
    expect(cards[0]!.reason).toBe("1 lesson waits for a maintainer's OK in \"web\"");
  });

  it("reads at most the bounded number of projects", async () => {
    let reads = 0;
    setLessonsHomeReader(async () => { reads += 1; return { waiting: 1 }; });
    const many = Array.from({ length: LESSON_HOME_PROJECTS_MAX + 5 }, (_, index) => ({ project: `p${String(index).padStart(2, "0")}`, role: "maintainer" }));
    expect(await lessonsHomeSource.list(deps(many), caller, {} as never)).toHaveLength(LESSON_HOME_PROJECTS_MAX);
    expect(reads).toBe(LESSON_HOME_PROJECTS_MAX);
  });
});
