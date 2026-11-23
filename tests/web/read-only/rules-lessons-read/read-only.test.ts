// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { mount } from "./mount.js";
describe("G4 pages that stay read-only", () => {
 // Rules rows, History, Models by stage and company Rules draw no write control (the live tools sit in Learned, Suggested rules and Setup recipes).
 for (const path of ["/app/projects/payments?tab=how-we-work&view=models", "/app/projects/payments?tab=how-we-work&view=history", "/app/admin/how-we-work"]) {
  it("renders no write controls or mutation on mount/refetch: " + path, async () => {
   const view = mount(path);await screen.findAllByRole("heading");await act(async () => { await view.query.invalidateQueries(); });
   for (const button of screen.queryAllByRole("button")) expect(button.textContent).toMatch(/^(Load again|Copy|Open)$/);
   expect(view.container.querySelectorAll("form,textarea,input,[role=switch],[contenteditable=true]")).toHaveLength(0);
   for (const button of screen.queryAllByRole("button")) fireEvent.click(button);
   expect(view.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
   expect(view.container.textContent).not.toMatch(/Confirm it's you|Save changes|Approve lesson|Share recipe|Roll back/);
  });
 }
 it("the read-only parts mount only local views and GET adapters, importing no write API", () => {
  const dir = "packages/ui/src/screens/rules-lessons-read";
  // The read-only parts only: the project views and company Rules (Learned and Setup recipes hold the live tools, proved in g4-ship-actions.test.ts).
  const source = ["parts.tsx", "ReadEntry.tsx", "ReadState.tsx", "ProjectModelChoicesReadPanel.tsx", "RuleHistoryReadPanel.tsx", "CompanyRulesReadScreen.tsx", "stale.tsx", "read-model.ts"].map(f => readFileSync(dir + "/" + f, "utf8")).join("\n");
  expect(source).not.toMatch(/\.send\(|useMutation|createLearnedApi|createLearningApi|createSetupRecipesApi|createBuilderApi|useHowWeWorkApi|useLessonInbox|useLessonsApi/);
  expect(source).not.toMatch(/from ["'].*(?:HowWeWorkTab|LearnedSection|SessionScreen|WorkScreen|SetupRecipesScreen)\.js/);
  // Every write on the mounted How we work tab and recipes comes from the live components, never from a new adapter here.
  expect(readFileSync(dir + "/ProjectHowWeWorkReadScreen.tsx", "utf8")).toMatch(/from "\.\.\/project\/LearningSection\.js"/);
 });
});
