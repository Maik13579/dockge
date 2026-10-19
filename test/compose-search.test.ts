import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test, TestContext } from "node:test";
import { searchTerminal } from "../frontend/src/terminal-search.js";

// Use the real xterm parser and buffer without opening a browser renderer.
Reflect.set(globalThis, "self", globalThis);
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

async function fixture(t: TestContext, text: string, cols = 40, scrollback = 1000) {
    const terminal = new Terminal({ cols,
        rows: 2,
        scrollback });
    t.after(() => terminal.dispose());
    let selected;
    let scrolled;
    Object.assign(terminal, {
        select: (column, row, length) => selected = { start: { x: column,
            y: row },
        length },
        getSelectionPosition: () => selected,
        clearSelection: () => selected = undefined,
        scrollToLine: row => scrolled = row,
    });
    const write = text => new Promise<void>(resolve => terminal.write(text, resolve));
    await write(text);
    return { terminal,
        write,
        selection: () => selected,
        scroll: () => scrolled };
}

test("log search finds case-insensitive literal text and navigates both ways with wraparound", async (t) => {
    const logs = await fixture(t, "alpha ERROR one\r\nbeta error two\r\nliteral [x].*\\\r\nlast ERROR");
    assert.equal(searchTerminal(logs.terminal, "error", { restart: true }), true);
    assert.deepEqual(logs.selection(), { start: { x: 6,
        y: 0 },
    length: 5 });
    assert.equal(searchTerminal(logs.terminal, "error"), true);
    assert.equal(logs.selection().start.y, 1);
    searchTerminal(logs.terminal, "error", { backwards: true });
    assert.equal(logs.selection().start.y, 0);
    searchTerminal(logs.terminal, "error", { backwards: true });
    assert.equal(logs.selection().start.y, 3);
    assert.equal(logs.scroll(), 2);
    searchTerminal(logs.terminal, "error");
    assert.equal(logs.selection().start.y, 0);
    searchTerminal(logs.terminal, "error", { backwards: true,
        restart: true });
    assert.equal(logs.selection().start.y, 3);
    for (const query of [ "[x]", ".*", "\\" ]) {
        assert.equal(searchTerminal(logs.terminal, query, { restart: true }), true);
        assert.equal(logs.selection().start.y, 2);
    }
    assert.equal(searchTerminal(logs.terminal, "missing"), false);
    assert.equal(logs.selection(), undefined);
    assert.equal(searchTerminal(logs.terminal, ""), false);
    assert.equal(logs.selection(), undefined);
});

test("log search crosses visual wrapping but never joins separate log lines", async (t) => {
    const logs = await fixture(t, "abcdefgh\x1b[31mERROR\x1b[0mtail\r\nabc\r\ndef", 10);
    assert.equal(searchTerminal(logs.terminal, "error", { restart: true }), true);
    assert.deepEqual(logs.selection(), { start: { x: 8,
        y: 0 },
    length: 5 });
    assert.equal(searchTerminal(logs.terminal, "abcdef", { restart: true }), true);
    assert.equal(searchTerminal(logs.terminal, "tailabc", { restart: true }), false);
    assert.equal(searchTerminal(logs.terminal, "abcdef", { backwards: true,
        restart: true }), true);
    assert.equal(logs.selection().start.y, 0, "The separate abc/def lines must not become another match");
});

test("log search maps wide and combining characters to terminal columns", async (t) => {
    const logs = await fixture(t, "界界 e\u0301 ERROR");
    assert.equal(searchTerminal(logs.terminal, "error", { restart: true }), true);
    assert.deepEqual(logs.selection(), { start: { x: 7,
        y: 0 },
    length: 5 });
    assert.equal(searchTerminal(logs.terminal, "e\u0301", { restart: true }), true);
    assert.equal(logs.selection().start.x, 5);
    assert.equal(logs.selection().length, 1);
    const wrapped = await fixture(t, "123456789界ERROR", 10);
    assert.equal(searchTerminal(wrapped.terminal, "9界E", { restart: true }), true);
    assert.deepEqual(wrapped.selection(), { start: { x: 8,
        y: 0 },
    length: 5 });
});

test("log search uses the current retained buffer after new output, trimming, and resize", async (t) => {
    const logs = await fixture(t, "first\r\nsecond\r\nthird\r\nfourth\r\nfifth", 20, 2);
    assert.equal(searchTerminal(logs.terminal, "first", { restart: true }), false);
    assert.equal(searchTerminal(logs.terminal, "latest", { restart: true }), false);
    await logs.write("\r\nlatest error\r\n");
    logs.terminal.resize(8, 2);
    assert.equal(searchTerminal(logs.terminal, "latest error", { restart: true }), true);
    assert.equal(logs.selection().length, 12);
    assert.equal(searchTerminal(undefined, "error"), false);
});
