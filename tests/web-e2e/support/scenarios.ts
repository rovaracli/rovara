import { navFixture, meFixture, homeFixture } from "../../web/support/fixtures.js";
export interface Scenario { name: "shell"; nav: ReturnType<typeof navFixture>; me: ReturnType<typeof meFixture>; home: ReturnType<typeof homeFixture> }
export function scenario(name: string): Scenario { if (name !== "shell") throw new Error("Unknown mock scenario.");return { name, nav: navFixture(), me: meFixture(), home: homeFixture() }; }
