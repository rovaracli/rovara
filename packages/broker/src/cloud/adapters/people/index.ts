// Convergence A6 (`cloud/people`): Cloud's IdentityProvider and Approvers adapters on Code's ports. Registered for conformance (tests/conformance/adapters/), not switched in: no route calls them yet.
// They live in the broker (not a separate package) because they wrap broker functions and the Cloud composition root (`cloud/app`, lane S3) will be in the broker too.
export * from "./methods.js";
export * from "./identity.js";
export * from "./approvers.js";
export * from "./issuers.js";
export * from "./gaps.js";
