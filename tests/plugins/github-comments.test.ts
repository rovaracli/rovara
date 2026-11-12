// Convergence lane A9: the GitHub App code host's conversation comments (Code's L12 seam: `comments`, fetch only, and `postComment`, Rovara's fixed text), through Cloud's real provider
// against Code's fixture of GitHub's API. Code's CodeHost suite has no check for them yet, so they are checked here.
import { describe, expect, it } from "vitest";
import { githubAppCodeHostWorld } from "../conformance/adapters/code-host-github-app.js";
import { workingBranch } from "../conformance/adapters/github-app-world.js";

async function openWorld() {
  const world = githubAppCodeHostWorld();
  world.model.commit(workingBranch(1), { "src/a.ts": "x\n" });
  const { ref } = await world.host.reconcileChangeRequest({ repository: world.repository, sourceBranch: workingBranch(1), targetBranch: "main", title: "t" }, world.scope);
  return { world, ref };
}

describe("GitHub App code host: conversation comments", () => {
  it("reads the conversation's comments with the place GitHub reports, the author and the times", async () => {
    const { world, ref } = await openWorld();
    world.model.addDiscussionComment(ref.id, "priya", "/rovara retry");
    world.model.addReviewComment(ref.id, "sam", "inline, not on the conversation", "src/a.ts", 1);
    const page = await world.host.comments!(ref, {}, world.scope);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]).toMatchObject({ ref: { repository: { url: world.repository.url }, id: ref.id }, author: { login: "priya", isBot: false }, body: "/rovara retry" });
    expect(page.nextPage).toBeUndefined();
  });

  it("refuses a bad page or time before asking GitHub, and reads a change request that is gone as no comments", async () => {
    const { world, ref } = await openWorld();
    const before = world.api.requests.length;
    await expect(world.host.comments!(ref, { page: 0 }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(world.host.comments!(ref, { since: "yesterday" }, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(world.api.requests.length).toBe(before);
    expect((await world.host.comments!({ ...ref, id: "999" }, {}, world.scope)).comments).toEqual([]);
  });

  it("posts only Rovara's fixed text, and says gone for a change request that is not there", async () => {
    const { world, ref } = await openWorld();
    expect(await world.host.postComment!(ref, "Started the retry.", world.scope)).toBe("posted");
    expect(world.model.getChangeRequest(ref.id).comments.map((comment) => comment.body)).toContain("Started the retry.");
    for (const text of ["", "x".repeat(201), "thanks @sam", "two\nlines"]) await expect(world.host.postComment!(ref, text, world.scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await world.host.postComment!({ ...ref, id: "999" }, "Started.", world.scope)).toBe("gone");
    await expect(world.host.postComment!(ref, "Started.", {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
