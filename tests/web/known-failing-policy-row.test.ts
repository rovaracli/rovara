// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { KnownFailingPolicyRow } from "../../packages/ui/src/screens/admin/how-we-work/KnownFailingPolicyRow.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

describe("known-failing company explanation", () => {
 it("explains that one maintainer may mark and exposes no retired policy controls", async () => {
  const f = renderUi(h(KnownFailingPolicyRow, {}));
  expect(await screen.findByRole("heading", { name: "Marking tests as already failing" })).toBeTruthy();
  expect(screen.getByText("One currently authorized project maintainer may mark eligible tests as already failing. Each mark is tied to the exact test and check.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/two people|different admin|signed in within/i)).toBeNull();
  f.unmount();
 });
});
