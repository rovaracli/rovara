// @vitest-environment jsdom
import { confirmUrlWithTicket } from "../../packages/broker/src/developer/decide-session.js";
import { afterEach, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { SafeMarkdown } from "../../packages/ui/src/design/SafeMarkdown.js";
import { VisibleText } from "../../packages/ui/src/design/VisibleText.js";
import { safeExternalUrl, isGithubUrl, isConfirmUrl } from "../../packages/ui/src/text/links.js";
import { stripTerminalEscapes } from "../../packages/ui/src/text/terminal.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
afterEach(cleanup);
it("never renders HTML, images, executable links or approval links from Markdown", () => {
 renderUi(h(SafeMarkdown, { markdown: '<script>alert(1)</script>\n\n<iframe src="x"></iframe>\n\n![image](https://example.com/a.png)\n\n[bad](javascript:alert(1)) [data](data:text/html,x) [decision](/v1/app/approve/apr_x?ticket=y) [foreign](//evil.example) [escaped](/app/%2e%2e/v1/app/approve/apr_x)' }));
 expect(document.querySelectorAll("script,iframe,img,a")).toHaveLength(0);
 expect(document.body.textContent).not.toContain("<script>");
 expect(screen.getByText(/decision/)).toBeTruthy();
});
it("links HTTPS safely and keeps permitted session links in the app", () => {
 renderUi(h(SafeMarkdown, { markdown: "[Code](https://github.com/x) [Task](/s/ses_aaaaaaaaaaaaaaaaaaaa)" }));
 const external = screen.getByRole("link", { name: "Code" });
 expect(external.getAttribute("rel")).toBe("noopener noreferrer");
 expect(screen.getByRole("link", { name: "Task" }).getAttribute("href")).toBe("/s/ses_aaaaaaaaaaaaaaaaaaaa");
});
it("shows control and format characters visibly while preserving newline and tab", () => {
 renderUi(h(VisibleText, { text: "a\u202Eb\n\t\u0000" }));
 expect(document.body.textContent).toContain("a[U+202E]b\n\t[U+0000]");
});
it("removes terminal CSI and OSC sequences before displaying peeks", () => {
 expect(stripTerminalEscapes("\x1b[32mok\x1b[0m")).toBe("ok");
 expect(stripTerminalEscapes("\x1b]8;;https://example.com\x07label\x1b]8;;\x1b\\")).toBe("label");
});
it("refuses unsafe external and confirmation destinations", () => {
 for (const url of ["http://example.com", "https://user:pass@example.com", "javascript:alert(1)", "//example.com", "https://example.com/\u202e"]) expect(safeExternalUrl(url)).toBeUndefined();
 expect(safeExternalUrl("https://example.com/a")).toBe("https://example.com/a");
 expect(isGithubUrl("https://github.com/acme/repo")).toBe(true);
 expect(isGithubUrl("https://github.com.evil.example/acme/repo")).toBe(false);
 const origin = "https://cell.example";
 expect(isConfirmUrl(origin + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", origin)).toBe(true);
 for (const url of ["https://evil.example/v1/app/approve/a", origin + "/v1/app/approve/a?ticket=x", origin + "/v1/app/approve/../other", origin + "/v1/app/approve/%2fother", origin + "/v1/app/approve/a/%2e%2e/apr_aaaaaaaaaaaaaaaaaaaa", origin + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa#details"]) expect(isConfirmUrl(url, origin)).toBe(false);
});

it("accepts a real broker ticket URL and refuses every alternate query shape", () => {
 const origin = "https://cell.example", path = origin + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", ticket = "a".repeat(43);
 expect(isConfirmUrl(confirmUrlWithTicket(origin, "apr_aaaaaaaaaaaaaaaaaaaa", ticket), origin)).toBe(true);
 for (const suffix of ["#", "?", "?ticket=", "?ticket=" + "a".repeat(42), "?ticket=" + "a".repeat(44), "?ticket=" + ticket + "&ticket=" + ticket, "?other=" + ticket, "?ticket=" + ticket + "&other=x", "?ticket=" + ticket + "#details", "?ticket=" + ticket + "#", "?%74icket=" + ticket, "?ticket=%61" + "a".repeat(42), "?ticket=" + ticket + "&"]) expect(isConfirmUrl(path + suffix, origin)).toBe(false);
});
