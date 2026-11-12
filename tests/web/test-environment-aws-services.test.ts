// @vitest-environment jsdom
// Test services, wide AWS plans (decision 109): the service picker of an emulated dependency lists the generated table with each service's fidelity score, says which ones start empty, and is searchable.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AWS_EMULATOR_SERVICES, TEST_ENV_DEPENDENCY_LIMITS, awsSeededKinds } from "@agentx/cloud-contracts/web";
import { h } from "./support/h.js";
import { AwsServicePicker, serviceNote } from "../../packages/ui/src/screens/onboarding/steps/AwsServicePicker.js";

afterEach(cleanup);

it("says each service's score and whether it starts empty, from the table", () => {
  expect(serviceNote("s3")).toMatch(/^AWS fidelity score \d{1,3}%\. Rovara creates the resources your project declares\.$/u);
  const empty = AWS_EMULATOR_SERVICES.find((row) => awsSeededKinds(row.key).length === 0 && row.behavioralOwnScore !== null)!;
  expect(serviceNote(empty.key)).toMatch(/^AWS fidelity score \d{1,3}%\. Starts empty; tests create their resources\.$/u);
  const unscored = AWS_EMULATOR_SERVICES.find((row) => row.behavioralOwnScore === null && awsSeededKinds(row.key).length === 0)!;
  expect(serviceNote(unscored.key)).toBe("AWS fidelity score: not scored. Starts empty; tests create their resources.");
});

it("lists the table, searches it by key and name, keeps the dependency's own service on, and saves the picked keys", () => {
  const onSave = vi.fn();
  render(h(AwsServicePicker, { selected: ["s3"], required: "s3", busy: false, onSave }));
  expect(screen.getByText(new RegExp(`serves ${String(AWS_EMULATOR_SERVICES.length)} AWS services`, "u"))).toBeTruthy();
  const list = screen.getByRole("list", { name: "AWS services" });
  expect(within(list).getAllByRole("checkbox").length).toBeLessThanOrEqual(41);
  const own: HTMLInputElement = within(list).getByRole("checkbox", { name: "s3" });
  expect(own.checked).toBe(true);
  expect(own.disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save the AWS services" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Search AWS services"), { target: { value: "kinesis" } });
  const kinesis = within(screen.getByRole("list", { name: "AWS services" })).getAllByRole("checkbox").find((box) => (box as HTMLInputElement).id === "aws-service-kinesis")!;
  fireEvent.click(kinesis);
  fireEvent.click(screen.getByRole("button", { name: "Save the AWS services" }));
  expect(onSave).toHaveBeenCalledWith(["s3", "kinesis"]);
  fireEvent.change(screen.getByLabelText("Search AWS services"), { target: { value: "zzzz-no-such" } });
  expect(screen.getByText("No AWS service matches that search.")).toBeTruthy();
});

it("stops at the environment's limit of services", () => {
  const picked = AWS_EMULATOR_SERVICES.slice(0, TEST_ENV_DEPENDENCY_LIMITS.awsServices).map((row) => row.key);
  render(h(AwsServicePicker, { selected: picked, required: picked[0]!, busy: false, onSave: () => undefined }));
  const other = AWS_EMULATOR_SERVICES.find((row) => !picked.includes(row.key))!;
  fireEvent.change(screen.getByLabelText("Search AWS services"), { target: { value: other.key } });
  const box = screen.getAllByRole("checkbox").find((candidate) => (candidate as HTMLInputElement).id === `aws-service-${other.key}`) as HTMLInputElement;
  expect(box.disabled).toBe(true);
});
