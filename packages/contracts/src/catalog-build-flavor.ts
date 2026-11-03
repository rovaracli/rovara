// Test services slice 1: which KIND of build this code is. The committed value is "release", and every public and Enterprise release is built from a clean checkout of a commit that says so (scripts/release/build.ts
// refuses anything else). Only the staging build path changes this one line, in its working copy, with scripts/release/catalog-flavor.ts (and a dirty tree can never be released). The staging-only catalog signing keys
// (`catalog-trust.ts`) are honoured by a "staging" build and by no other: in a release build the check below is false whatever account the code runs in.
export const CATALOG_BUILD_FLAVOR: "release" | "staging" = "release";
