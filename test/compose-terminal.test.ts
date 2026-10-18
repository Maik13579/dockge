import assert from "node:assert/strict";
import { test } from "node:test";
import { Terminal } from "../backend/terminal";
import { TerminalSocketHandler } from "../backend/agent-socket-handlers/terminal-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import { DockgeServer } from "../backend/dockge-server";
import { DockgeSocket } from "../backend/util-server";

// Keep the real command scheduling, listeners and socket handlers. Only replace
// the OS process with a controllable terminal, without Docker or native PTYs.
class TestTerminal extends Terminal {
    send(data: string) {
        this.buffer.pushItem(data);
        for (const socket of Object.values(this.socketList)) {
            socket.emitAgent("terminalWrite", this.name, data);
        }
    }

    finish(code = 0) {
        this.exit({ exitCode: code });
    }
}

test("Stop interrupts pending up, waits for its exit, then executes down", async (t) => {
    const server = {} as DockgeServer;
    const commands: string[][] = [];
    let interrupted = false;
    t.mock.method(Terminal.prototype, "start", function (this: TestTerminal & { args: string[] }) {
        commands.push(this.args);
        if (this.args.includes("up")) {
            Object.assign(this, { _ptyProcess: {
                write: (input: string) => {
                    assert.equal(input, "\x03");
                    interrupted = true;
                },
            } });
        } else {
            assert.equal(Terminal.getTerminal(this.name), this);
            TestTerminal.prototype.finish.call(this);
        }
    });
    const name = "compose-interrupt-test";
    t.after(() => {
        const pending = Terminal.getTerminal(name);
        if (pending) {
            TestTerminal.prototype.finish.call(pending);
        }
    });
    const up = Terminal.exec(server, undefined, name, "docker", [ "compose", "up", "-d" ], "/");
    const cancelled = assert.rejects(up, /cancelled by Stop/);
    const down = Terminal.exec(server, undefined, name, "docker", [ "compose", "down" ], "/", true);
    assert.equal(interrupted, true);
    assert.equal(commands.length, 1, "Down must wait until Up has stopped creating containers");
    TestTerminal.prototype.finish.call(Terminal.getTerminal(name), 130);
    await cancelled;
    assert.equal(await down, 0);
    assert.deepEqual(commands, [[ "compose", "up", "-d" ], [ "compose", "down" ]]);
    assert.equal(Terminal.getTerminal(name), undefined);
});

test("a competing operation rejects with an Error so socket handlers always reply", async () => {
    const server = {} as DockgeServer;
    const terminal = new TestTerminal(server, "compose-busy-test", "docker", [], "/");
    try {
        await assert.rejects(Terminal.exec(server, undefined, terminal.name, "docker", [], "/"), error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Another operation/);
            return true;
        });
    } finally {
        terminal.finish();
    }
});

test("Stop can replace a Compose command that ignores Ctrl+C", async (t) => {
    const server = {} as DockgeServer;
    const signals: string[] = [];
    const name = "compose-force-interrupt-test";
    t.mock.method(Terminal.prototype, "start", function (this: Terminal) {
        const finish = Reflect.get(this, "exit");
        if ((Reflect.get(this, "args") as string[]).includes("up")) {
            Object.assign(this, { _ptyProcess: {
                write: () => signals.push("Ctrl+C"),
                kill: (signal: string) => {
                    signals.push(signal);
                    finish({ exitCode: 137 });
                },
            } });
        } else {
            finish({ exitCode: 0 });
        }
    });
    t.after(() => {
        const terminal = Terminal.getTerminal(name);
        if (terminal) {
            Reflect.get(terminal, "exit")({ exitCode: 0 });
        }
    });
    const up = Terminal.exec(server, undefined, name, "docker", [ "compose", "up", "-d" ], "/");
    const cancelled = assert.rejects(up, /cancelled by Stop/);
    assert.equal(await Terminal.exec(server, undefined, name, "docker", [ "compose", "down" ], "/", true), 0);
    await cancelled;
    assert.deepEqual(signals, [ "Ctrl+C", "SIGKILL" ]);
});

test("reopening a terminal returns its buffer and subscribes to subsequent live output", async () => {
    const server = {} as DockgeServer;
    const events: unknown[][] = [];
    const socket = { id: "reopened-page",
        userID: 1,
        emitAgent: (...args: unknown[]) => events.push(args) } as unknown as DockgeSocket;
    const agent = new AgentSocket();
    new TerminalSocketHandler().create(socket, server, agent);
    const terminal = new TestTerminal(server, "compose-reopen-test", "docker", [], "/");
    try {
        terminal.send("Waiting for database health\r\n");
        let reply;
        agent.call("terminalJoin", terminal.name, (res: unknown) => {
            reply = res;
        });
        assert.deepEqual(reply, { ok: true,
            buffer: "Waiting for database health\r\n" });
        terminal.send("Database is healthy\r\n");
        assert.deepEqual(events, [[ "terminalWrite", terminal.name, "Database is healthy\r\n" ]]);
    } finally {
        terminal.finish();
    }
});
