import { expect, it } from "vitest";
import { createCodeApi } from "../../packages/ui/src/api/code.js";
import { fakeHost } from "./support/fake-host.js";
it("the task answer's Quick start transport never retries a throttled write", async () => {
 const f = fakeHost(async () => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "No confirmed result" } } }));
 await expect(createCodeApi(f.host).startCode("payments", "Fix the refund retry", "11111111-1111-4111-8111-111111111111", "quick")).rejects.toMatchObject({ status: 429 });
 expect(f.request).toHaveBeenCalledTimes(1);
});
