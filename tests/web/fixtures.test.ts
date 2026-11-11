import { expect, it } from "vitest";
import { AppMeResponseSchema, AppNavSchema, HomeResponseSchema } from "@agentx/cloud-contracts/web";
import { navFixture, meFixture, homeFixture } from "./support/fixtures.js";
it("builds only contract-valid mock cell defaults", () => {
 expect(AppNavSchema.parse(navFixture()).homeCount).toBe(3);expect(AppMeResponseSchema.parse(meFixture()).developer.name).toBe("Priya");expect(HomeResponseSchema.parse(homeFixture()).cards).toEqual([]);
});
it("refuses unknown fixture fields instead of silently drifting from server contracts", () => {
 expect(() => navFixture({ extra: true } as never)).toThrow();expect(() => meFixture({ extra: true } as never)).toThrow();expect(() => meFixture({ developer: { ...meFixture().developer, extra: true } } as never)).toThrow();expect(() => homeFixture({ extra: true } as never)).toThrow();
});
