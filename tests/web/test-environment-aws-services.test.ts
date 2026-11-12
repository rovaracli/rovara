// @vitest-environment jsdom
// Test services, wide AWS plans (decision 109): the service picker of an emulated dependency lists the generated table with each service's fidelity score, says which ones start empty, is searchable by key and by SDK name,
// keeps the picked ones on top, says when it shows only part of the table or has reached its limit, locks the dependency's own service, and refuses a save built on a proposal that has moved on.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AWS_EMULATOR_SERVICES, TEST_ENV_DEPENDENCY_LIMITS, awsSeededKinds } from "@agentx/cloud-contracts/web";
import { h } from "./support/h.js";
import { AWS_PICKER_SHOWN, AwsServicePicker, serviceNote, type AwsServicesSaveResult } from "../../packages/ui/src/screens/onboarding/steps/AwsServicePicker.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const SNAPSHOT = { digest: "a".repeat(64), environment: { marker: "opened" } };
const ok = (): Promise<AwsServicesSaveResult> => Promise.resolve({ ok: true });
const picker = (over: Partial<Parameters<typeof AwsServicePicker>[0]> = {}) => h(AwsServicePicker, { snapshot: SNAPSHOT, selected: ["s3"], required: "s3", onSave: ok, onDiscard: () => undefined, ...over });
const box = (key: string): HTMLInputElement => screen.getAllByRole("checkbox").find((candidate) => (candidate as HTMLInputElement).id === `aws-service-${key}`) as HTMLInputElement;
const search = (value: string) => fireEvent.change(screen.getByLabelText("Search AWS services"), { target: { value } });

it("says each service's score and whether it starts empty, from the table", () => {
  expect(serviceNote("s3")).toMatch(/^AWS fidelity score \d{1,3}%\. Rovara creates the resources your project declares\.$/u);
  const empty = AWS_EMULATOR_SERVICES.find((row) => awsSeededKinds(row.key).length === 0 && row.behavioralOwnScore !== null)!;
  expect(serviceNote(empty.key)).toMatch(/^AWS fidelity score \d{1,3}%\. Starts empty; tests create their resources\.$/u);
  const unscored = AWS_EMULATOR_SERVICES.find((row) => row.behavioralOwnScore === null && awsSeededKinds(row.key).length === 0)!;
  expect(serviceNote(unscored.key)).toBe("AWS fidelity score: not scored. Starts empty; tests create their resources.");
});

it("lists the table with a visible cap, the required service on top, checked and locked, and 'used by this dependency'", () => {
  render(picker());
  expect(screen.getByText(new RegExp(`serves ${String(AWS_EMULATOR_SERVICES.length)} AWS services`, "u"))).toBeTruthy();
  const list = screen.getByRole("list", { name: "AWS services" });
  const rows = within(list).getAllByRole("checkbox");
  expect(rows).toHaveLength(AWS_PICKER_SHOWN);
  expect((rows[0] as HTMLInputElement).id).toBe("aws-service-s3");
  expect(box("s3").checked).toBe(true);
  expect(box("s3").disabled).toBe(true);
  expect(screen.getByText("used by this dependency")).toBeTruthy();
  expect(screen.getByText(`Showing ${String(AWS_PICKER_SHOWN)} of ${String(AWS_EMULATOR_SERVICES.length)}. Search to narrow.`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save the AWS services" })).toHaveProperty("disabled", true);
});

it("starts with the required service picked even when the saved list does not name it", () => {
  render(picker({ selected: ["sqs"], required: "s3" }));
  expect(box("s3").checked).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("2 picked");
});

it("searches by key and by SDK name, says when nothing matches, and drops the cap note when everything shown fits", () => {
  render(picker());
  search("kinesis");
  expect(box("kinesis")).toBeTruthy();
  const row = AWS_EMULATOR_SERVICES.find((candidate) => candidate.key === "secrets-manager")!;
  search(row.sdkId.toLowerCase());
  expect(box("secrets-manager")).toBeTruthy();
  expect(screen.queryByText(/Search to narrow/u)).toBeNull();
  search("zzzz-no-such");
  expect(screen.getByText("No AWS service matches that search.")).toBeTruthy();
});

it("keeps the picked rows on top while the search changes and saves the picked keys from the snapshot it opened on", async () => {
  const onSave = vi.fn(ok);
  render(picker({ onSave }));
  search("kinesis");
  fireEvent.click(box("kinesis"));
  search("");
  const first = within(screen.getByRole("list", { name: "AWS services" })).getAllByRole("checkbox").slice(0, 2).map((candidate) => (candidate as HTMLInputElement).id);
  expect([...first].sort()).toEqual(["aws-service-kinesis", "aws-service-s3"]);
  fireEvent.click(screen.getByRole("button", { name: "Save the AWS services" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(SNAPSHOT, ["s3", "kinesis"]);
});

it("stops at the environment's limit, and says why the other boxes are off", () => {
  const picked = AWS_EMULATOR_SERVICES.slice(0, TEST_ENV_DEPENDENCY_LIMITS.awsServices).map((row) => row.key);
  render(picker({ selected: picked, required: picked[0] }));
  const other = AWS_EMULATOR_SERVICES.find((row) => !picked.includes(row.key))!;
  search(other.key);
  expect(box(other.key).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain(`You can pick up to ${String(TEST_ENV_DEPENDENCY_LIMITS.awsServices)}`);
  // A picked one can still be cleared, except the required one.
  search(picked[1]!);
  expect(box(picked[1]!).disabled).toBe(false);
});

it("shows its own busy state while saving, keeps the picks on a stale answer, and starts again on 'Discard my changes and reload'", async () => {
  let finish!: (value: AwsServicesSaveResult) => void;
  const onSave = vi.fn(() => new Promise<AwsServicesSaveResult>((resolve) => { finish = resolve; }));
  const onDiscard = vi.fn();
  render(picker({ onSave, onDiscard }));
  search("kinesis");
  fireEvent.click(box("kinesis"));
  const save = screen.getByRole("button", { name: "Save the AWS services" });
  fireEvent.click(save);
  await waitFor(() => expect(save.getAttribute("aria-busy") === "true" || (save as HTMLButtonElement).disabled).toBe(true));
  finish({ ok: false, stale: true, message: "This test environment changed since you opened the AWS services." });
  expect((await screen.findByRole("alert")).textContent).toContain("changed since you opened");
  expect(box("kinesis").checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
});

it("has no axe violations in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
    const ui = renderUi(picker(), { theme });
    await expectNoAxeViolations(ui.container);
    ui.unmount();
  }
});
