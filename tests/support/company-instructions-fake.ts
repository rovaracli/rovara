// A test fake for the CompanyInstructionsSource port (lane I2): answers the given snapshots in turn (the last one repeats; an Error among them fails that call), or fails every call when given an Error. Records the company key of each call.
import type { CompanyInstructionsSnapshot } from "@rovara-code/contracts";
import type { CompanyInstructionsSource } from "../../packages/broker/src/instructions/company-source.js";

export interface FakeCompanyInstructionsSource extends CompanyInstructionsSource {
  /** The company key each call asked for, in order. */
  readonly asked: string[];
}

export function fakeCompanyInstructionsSource(answers: ReadonlyArray<CompanyInstructionsSnapshot | undefined | Error> | Error): FakeCompanyInstructionsSource {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    current(company: string): Promise<CompanyInstructionsSnapshot | undefined> {
      asked.push(company);
      if (answers instanceof Error) return Promise.reject(answers);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer === undefined ? undefined : structuredClone(answer));
    },
  };
}
