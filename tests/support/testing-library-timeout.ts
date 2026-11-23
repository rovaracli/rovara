// Cloud train 4 (2026-11-22): lazily loaded routes can take longer than Testing Library's default 1 s to render on CI
// (findByRole timed out on "Approve plan v1" in run 45093927837 although it passes locally). Raise the wait for every
// findBy*/waitFor; tests still fail, only later. Node-environment tests never call it, so this is inert for them.
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 5_000 });
