// What the page reads, as the forward-compatible readers give it (a newer server may add a word these types don't list).
import type { ForwardReader, CompanyRulesState, CompanyRulesHistory, CompanyRulesSync, CompanyRulesVersionView } from "@agentx/cloud-contracts/web";
export type State = ForwardReader<CompanyRulesState>;
export type Proposal = NonNullable<State["pending"]>;
export type Version = ForwardReader<CompanyRulesVersionView>["version"];
export type History = ForwardReader<CompanyRulesHistory>;
export type SyncDetail = ForwardReader<CompanyRulesSync>;
