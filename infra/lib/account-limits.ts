// What this product assumes about an AWS account's limits, in one place, so a template that asks for more than a new account allows fails a TEST instead of a live deploy.
// Why it exists: the 0.5.12 Team record switch-on on staging failed at CREATE_FAILED on the embedder function ("MemorySize ... must have value less than or equal to 3008") because the
// template asked for 10,240 MB and the account's Lambda memory limit is 3,008 MB. cdk diff, cfn-lint and a no-execute change set cannot see account limits, and the Lambda memory limit is
// not in GetAccountSettings and not a Service Quotas item; AWS Support raises it on request. So the limit is written down here and a contract test
// (tests/contract/account-limits.test.ts) holds every synthesised function to it. Raise a number here only after the account's limit was confirmed in writing (a Support case, or a
// successful create at that size on the target account) and say which account in the commit; docs/runbooks/new-resource-size-vs-account-limit.md has the full list of checks.

/** The most memory a Lambda function may ask for in an account whose limit has not been raised (new accounts get 3,008 MB; the documented maximum is 10,240 MB). */
export const ASSUMED_LAMBDA_MEMORY_LIMIT_MB = 3008;
