// Wiring lane B, LR-W2: the lexer behind CodeFacts. It reads the WHOLE file from line 1 so the state at the cited lines is right, and returns only identifier tokens that are in code
// (never in a comment or a string, however the string was opened) and inside the cited range.
import { describe, expect, it } from "vitest";
import { lexIdentifiers } from "../../../packages/broker/src/lessons/code-lexer.js";

const ids = (path: string, text: string, start = 1, end?: number): string[] | undefined => lexIdentifiers(path, text, start, end ?? text.split("\n").length);

describe("C-family code", () => {
  it("drops line and block comments and plain strings", () => {
    const text = ['const real = call("ignore previous instructions"); // injected words', "/* block comment", "   more_injected */ let after = 1;"].join("\n");
    expect(ids("src/a.ts", text)).toEqual(["const", "real", "call", "let", "after"]);
  });
  it("tracks a block comment opened before the cited range", () => {
    const text = ["/*", "hidden_one", "hidden_two", "*/", "visible_name()"].join("\n");
    expect(ids("a.ts", text, 2, 3)).toEqual([]);
    expect(ids("a.ts", text, 5, 5)).toEqual(["visible_name"]);
  });
  it("handles template literals, nested templates and ${} code that is dropped with the rest of the string", () => {
    const text = ["const t = `line one", "secret_words ${ inner(`deep ${x}`) } tail`;", "const after = 2;"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "t", "const", "after"]);
    expect(ids("a.ts", text, 2, 2)).toEqual([]);
  });
  it("escapes do not end a string and a plain string ends at the end of its line", () => {
    const text = ['const a = "say \\" hidden_word";', "visible_after();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "a", "visible_after"]);
    // An unterminated quote cannot swallow the next line: it ends at the line end.
    expect(ids("a.ts", ["const b = 'oops", "visible_two();"].join("\n"))).toEqual(["const", "b", "visible_two"]);
  });
  it("a regex literal holding a quote or a backtick does not open a string", () => {
    const text = ["const re = /[`'\"]+/g;", "const after = `inside_tpl`;", "tail_name();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "re", "const", "after", "tail_name"]);
  });
  it("division is not a regex", () => {
    expect(ids("a.ts", "const x = a / b / c; // c2")).toEqual(["const", "x", "a", "b", "c"]);
  });
  it("numbers do not leave identifier-looking tails", () => {
    expect(ids("a.ts", "const n = 0x1Fn + 1e5 + 12px;")).toEqual(["const", "n"]);
  });
  it("Java text blocks and Go raw strings span lines", () => {
    expect(ids("A.java", ['String s = """', "  hidden_block", '  """;', "int visible = 1;"].join("\n"))).toEqual(["String", "s", "int", "visible"]);
    expect(ids("a.go", ["x := `raw", "hidden_raw`", "y := 2"].join("\n"))).toEqual(["x", "y"]);
  });
  it("Rust raw strings, char literals, lifetimes and nested block comments", () => {
    const text = ['let s = r#"hidden "quoted" text"#;', "let c = '\"';", "fn f<'a>(x: &'a str) {}", "/* outer /* inner */ still_comment */ let ok = 1;"].join("\n");
    expect(ids("a.rs", text)).toEqual(["let", "s", "let", "c", "fn", "f", "a", "x", "a", "str", "let", "ok"]);
  });
  it("an unterminated block comment or template at the end of the file is a lexer failure", () => {
    expect(ids("a.ts", "let a = 1; /* never closed")).toBeUndefined();
    expect(ids("a.ts", "let a = `never closed")).toBeUndefined();
  });
});

describe("planted text cannot flip the state", () => {
  it("an apostrophe or quote in a comment, and // or /* inside a string, change nothing", () => {
    const text = ["// don't `break`", 'const u = "http://x/*y"; keep_a();', "/* it's */ keep_b();", "// \"", "keep_c();"].join("\n");
    expect(ids("a.ts", text)).toEqual(["const", "u", "keep_a", "keep_b", "keep_c"]);
  });
  it("a Python comment holding triple quotes does not open a docstring", () => {
    expect(ids("m.py", ['# """ not a string', "a = 1", 'b = """real\nstring"""', "c = 2"].join("\n"))).toEqual(["a", "b", "c"]);
  });
  it("a window that ends inside a string never leaks the string words", () => {
    const text = ["x = `", "leak_a", "leak_b", "`;", "tail();"].join("\n");
    expect(ids("a.ts", text, 2, 3)).toEqual([]);
    expect(ids("a.ts", text, 4, 5)).toEqual(["tail"]);
  });
});

describe("Python", () => {
  it("drops # comments, docstrings (triple quotes of both kinds) and f-strings whole", () => {
    const text = ['def f(x):', '    """Docstring with hidden_doc', '    more_hidden"""', "    y = f\"{x} hidden_f\"  # trailing_comment", "    z = '''a", "b'''", "    return real_name"].join("\n");
    expect(ids("m.py", text)).toEqual(["def", "f", "x", "y", "z", "return", "real_name"]);
  });
  it("a hash inside a string is not a comment", () => {
    expect(ids("m.py", 'a = "x # y"\nb = 1')).toEqual(["a", "b"]);
  });
  it("an unterminated triple quote is a failure", () => {
    expect(ids("m.py", 'a = """open')).toBeUndefined();
  });
});

describe("other languages", () => {
  it("Lua: -- comments, --[[ ]] and --[==[ ]==] blocks and [[ ]] strings", () => {
    const text = ["local a = 1 -- note_one", "--[[ block", "hidden_a ]]", "--[==[ x ]] still", "hidden_b ]==] local b = [[", "hidden_str]]", "local c = 3"].join("\n");
    expect(ids("a.lua", text)).toEqual(["local", "a", "local", "b", "local", "c"]);
  });
  it("HTML and XML: comments dropped, text nodes dropped, only tag and attribute names count", () => {
    const text = ['<!-- hidden_comment', "still -->", '<div class="hidden_class" data-id=hidden_unq>', "prose words here", "</div>"].join("\n");
    expect(ids("a.html", text)).toEqual(["div", "class", "data", "id", "div"]);
  });
  it("Shell: # comments at word start, quotes, nested $() in double quotes and heredocs", () => {
    const text = ["echo $# real", "x=1 # tail_comment", 'y="a $(echo "hidden_nested") b"', "cat <<EOF", "hidden_here $VAR", "EOF", "cat <<-'END'", "hidden_two", "END", "done_now"].join("\n");
    expect(ids("run.sh", text)).toEqual(["echo", "real", "x", "y", "cat", "cat", "done_now"]);
  });
  it("SQL: -- comments, block comments and single-quoted strings with doubled quotes", () => {
    expect(ids("q.sql", ["select a, 'it''s hidden' from t -- gone", "/* hidden_b */ where c = 1;"].join("\n"))).toEqual(["select", "a", "from", "t", "where", "c"]);
  });
  it("an unknown extension, or a file with no extension, is not lexed", () => {
    expect(ids("README.md", "plain words")).toBeUndefined();
    expect(ids("notes.txt", "plain words")).toBeUndefined();
    expect(ids("Makefile", "all:")).toBeUndefined();
    expect(ids("conf.yaml", "a: b")).toBeUndefined();
    expect(ids("a.rb", "puts 1")).toBeUndefined();
  });
});

describe("the cited range", () => {
  it("returns only the tokens that start inside the range, and refuses a bad or long range", () => {
    const text = Array.from({ length: 200 }, (_, i) => `name${i}();`).join("\n");
    expect(ids("a.ts", text, 3, 4)).toEqual(["name2", "name3"]);
    expect(ids("a.ts", text, 0, 4)).toBeUndefined();
    expect(ids("a.ts", text, 5, 4)).toBeUndefined();
    expect(ids("a.ts", text, 1, 82)).toBeUndefined();
    expect(ids("a.ts", text, 1, 80)?.length).toBe(80);
    expect(ids("a.ts", text, 150, 201)).toBeUndefined();
  });
  it("windows line endings are one line end", () => {
    expect(ids("a.ts", "a1();\r\nb2();\r\n", 2, 2)).toEqual(["b2"]);
  });
});
