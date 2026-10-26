import { afterEach, expect, it, vi } from "vitest";
import { DraftState, moveStep, removeStep, allowedStepKinds } from "../../packages/ui/src/screens/builder/draft-state.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
afterEach(() => vi.useRealTimers());
it("debounces edits for800ms and serializes saves with the returned revision", async () => {
 vi.useFakeTimers();let release!: (value: { revision: number }) => void;
 const save = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue({ revision: 9 });
 const draft = new DraftState({ instructions: "original" }, 7, save);
 draft.edit({ instructions: "first" });await vi.advanceTimersByTimeAsync(400);draft.edit({ instructions: "second" });await vi.advanceTimersByTimeAsync(799);expect(save).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(save).toHaveBeenCalledExactlyOnceWith({ instructions: "second" }, 7);draft.edit({ instructions: "third" });await vi.advanceTimersByTimeAsync(800);expect(save).toHaveBeenCalledTimes(1);
 release({ revision: 8 });await vi.advanceTimersByTimeAsync(0);expect(save).toHaveBeenCalledTimes(2);expect(save).toHaveBeenLastCalledWith({ instructions: "third" }, 8);expect(draft.snapshot().status).toBe("saved");draft.dispose();
});
it("keeps the exact edit and conflict message without retrying over newer work", async () => {
 vi.useFakeTimers();const save = vi.fn().mockRejectedValue(new ApiError(409, "AGENT_REVISION_CONFLICT", "Someone else changed this agent's draft. Reload it and make your change again."));const draft = new DraftState({}, 2, save);
 draft.edit({ instructions: "Keep this unsaved work" });await vi.advanceTimersByTimeAsync(800);expect(draft.snapshot()).toMatchObject({ overlay: { instructions: "Keep this unsaved work" }, status: "conflict", error: "Someone else changed this agent's draft. Reload it and make your change again." });
 draft.edit({ instructions: "More local work" });await vi.advanceTimersByTimeAsync(10000);expect(save).toHaveBeenCalledTimes(1);expect(draft.snapshot().overlay.instructions).toBe("More local work");draft.dispose();
});
it("never reports an older in-flight save as saving newer edits", async () => {
 vi.useFakeTimers();let release!: (value: { revision: number }) => void;const save = vi.fn().mockImplementation(() => new Promise(resolve => { release = resolve; }));const draft = new DraftState({},1,save);
 draft.edit({ instructions: "first" });await vi.advanceTimersByTimeAsync(800);draft.edit({ instructions: "second" });release({ revision: 2 });await vi.advanceTimersByTimeAsync(0);expect(draft.snapshot().status).toBe("unsaved");await vi.advanceTimersByTimeAsync(800);expect(save).toHaveBeenCalledTimes(2);draft.dispose();
});
it("allows only the recipe family and preserves the exact shown order", () => {
 const sequence = [{ id: "plan", name: "Plan", kind: "plan" as const }, { id: "build", name: "Build", kind: "build" as const }, { id: "review", name: "Review", kind: "review" as const, reviewers: ["code" as const] }];
 expect(allowedStepKinds(sequence)).not.toContain("approval");expect(allowedStepKinds([{ id: "work", name: "Work", kind: "agent", workspace: "none" }])).toEqual(["agent", "approval"]);
 expect(moveStep(sequence,"review","build").map(step=>step.id)).toEqual(["plan","review","build"]);expect(()=>removeStep([sequence[0]!],"plan")).toThrow("An agent needs at least one step");
});
it("disposes pending saves without making a write", async () => { vi.useFakeTimers();const save=vi.fn();const draft=new DraftState({},1,save);draft.edit({instructions:"Local"});draft.dispose();await vi.advanceTimersByTimeAsync(1000);expect(save).not.toHaveBeenCalled(); });
