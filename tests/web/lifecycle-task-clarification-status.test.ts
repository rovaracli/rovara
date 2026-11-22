// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { AppMeResponseReaderSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { ClarificationResponseStatusView } from "../../packages/ui/src/screens/session/ClarificationResponseStatusView.js";
import { understandSession } from "./support/understand-fixture.js";
import { meFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

const identity = AppMeResponseReaderSchema.parse(meFixture());
const session = SessionViewReaderSchema.parse(understandSession());
const activeRound = session.body.kind === "task" ? session.body.task.workflow?.intent?.rounds ?? 0 : 0;
const answerReceipt = {
  companyId: identity.org.orgId,
  personId: identity.developer.id,
  round: activeRound,
  answers: ["The payments table", "Yes, migrate last year's refunds"],
};

it("keeps pending confirmation distinct from a failed submission on the same question round", () => {
  const f = renderUi(h(ClarificationResponseStatusView, {
    status: "pending",
    round: activeRound,
    identity: { companyId: answerReceipt.companyId, personId: answerReceipt.personId },
    retained: answerReceipt,
  }));

  expect(screen.getByRole("status").textContent).toBe("Your answers are not confirmed yet. Keep them here and check this question round's current status.");
  expect(screen.getByText("The payments table")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
  f.unmount();

  const failed = renderUi(h(ClarificationResponseStatusView, {
    status: "failed",
    round: activeRound,
    identity: { companyId: answerReceipt.companyId, personId: answerReceipt.personId },
    retained: answerReceipt,
  }));
  expect(screen.getByRole("status").textContent).toBe("Rovara did not confirm your answers. They remain on this page. Check the current question round before submitting again.");
  expect(screen.getByText("The payments table")).toBeTruthy();
  failed.unmount();
});

it("does not show answers from another round, company, or person", () => {
  const answersFromOtherRound = renderUi(h(ClarificationResponseStatusView, {
    status: "pending",
    round: activeRound + 1,
    identity: { companyId: answerReceipt.companyId, personId: answerReceipt.personId },
    retained: answerReceipt,
  }));
  expect(within(answersFromOtherRound.container).queryByText("The payments table")).toBeNull();
  answersFromOtherRound.unmount();

  const answersFromOtherCompany = renderUi(h(ClarificationResponseStatusView, {
    status: "pending",
    round: activeRound,
    identity: { companyId: "org_bbbbbbbbbbbbbbbbbbbb", personId: answerReceipt.personId },
    retained: answerReceipt,
  }));
  expect(within(answersFromOtherCompany.container).queryByText("The payments table")).toBeNull();
  answersFromOtherCompany.unmount();

  const answersFromOtherPerson = renderUi(h(ClarificationResponseStatusView, {
    status: "pending",
    round: activeRound,
    identity: { companyId: answerReceipt.companyId, personId: "b".repeat(64) },
    retained: answerReceipt,
  }));
  expect(within(answersFromOtherPerson.container).queryByText("The payments table")).toBeNull();
  answersFromOtherPerson.unmount();
});

