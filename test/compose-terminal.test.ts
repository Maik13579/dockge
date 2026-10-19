import assert from "node:assert/strict";
import { test } from "node:test";
import { Terminal } from "../backend/terminal";
import { TerminalSocketHandler } from "../backend/agent-socket-handlers/terminal-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import { DockgeServer } from "../backend/dockge-server";
import { DockgeSocket } from "../backend/util-server";
import { Stack } from "../backend/stack";
import { getCombinedTerminalName, getContainerLogsTerminalName } from "../common/util-common";

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

test("service commands run during bulk Up, retain its progress, and all stop before Down", async (t) => {
    const server = {} as DockgeServer;
    const name = "compose-parallel-services-test";
    const processes = new Map<string, { terminal: Terminal, finish: (res: { exitCode: number }) => void }>();
    const interrupted: string[] = [];
    let shutdownStarted: () => void;
    const shuttingDown = new Promise<void>(resolve => {
        shutdownStarted = resolve;
    });
    t.mock.method(Terminal.prototype, "start", function (this: Terminal) {
        const key = Reflect.get(this, "operationName") as string;
        const finish = Reflect.get(this, "exit");
        processes.set(key, { terminal: this,
            finish });
        Object.assign(this, { _ptyProcess: { write: (input: string) => {
            assert.equal(input, "\x03");
            interrupted.push(key);
        } } });
        if ((Reflect.get(this, "args") as string[]).includes("down")) {
            shutdownStarted();
        }
    });
    t.after(() => {
        for (const process of processes.values()) {
            process.finish({ exitCode: 0 });
        }
    });
    const up = Terminal.exec(server, undefined, name, "docker", [ "compose", "up", "-d" ], "/");
    const first = Terminal.exec(server, undefined, name, "docker", [ "compose", "up", "-d", "first" ], "/", false, `${name}:service:first`);
    const second = Terminal.exec(server, undefined, name, "docker", [ "compose", "up", "-d", "second" ], "/", false, `${name}:service:second`);
    assert.equal(Terminal.getTerminals(name).length, 3);
    assert.equal(Terminal.getTerminal(name), processes.get(name)?.terminal);
    await assert.rejects(Terminal.exec(server, undefined, name, "docker", [], "/", false, `${name}:service:first`), /Another operation/);
    await assert.rejects(Terminal.exec(server, undefined, name, "docker", [], "/"), /Another operation/);
    const cancelled = [ up, first, second ].map(promise => assert.rejects(promise, /cancelled by Stop/));
    const down = Terminal.exec(server, undefined, name, "docker", [ "compose", "down" ], "/", true);
    assert.equal(interrupted.length, 3);
    await assert.rejects(Terminal.exec(server, undefined, name, "docker", [], "/", false, `${name}:service:third`), /stack is stopping/);
    for (const process of processes.values()) {
        process.finish({ exitCode: 130 });
    }
    await shuttingDown;
    await Promise.all(cancelled);
    assert.equal(Terminal.getTerminals(name).length, 1);
    await assert.rejects(Terminal.exec(server, undefined, name, "docker", [], "/", false, `${name}:service:third`), /stack is stopping/);
    processes.get(name)!.finish({ exitCode: 0 });
    assert.equal(await down, 0);
    assert.equal(Terminal.getTerminals(name).length, 0);
    const retry = Terminal.exec(server, undefined, name, "docker", [], "/", false, `${name}:service:third`);
    processes.get(`${name}:service:third`)!.finish({ exitCode: 0 });
    assert.equal(await retry, 0, "The shutdown lock must be released after Down");
});

test("reopening the shared progress display subscribes to every service command", () => {
    const server = {} as DockgeServer;
    const events: unknown[][] = [];
    const socket = { id: "reopened-services",
        userID: 1,
        emitAgent: (...args: unknown[]) => events.push(args) } as unknown as DockgeSocket;
    const agent = new AgentSocket();
    new TerminalSocketHandler().create(socket, server, agent);
    const name = "compose-service-progress-test";
    const terminals = [ "first", "second" ].map(service => new TestTerminal(server, name, "docker", [], "/", `${name}:service:${service}`));
    try {
        terminals[0].send("First service starting\r\n");
        terminals[1].send("Second service starting\r\n");
        let buffer = "";
        agent.call("terminalJoin", name, (res: { buffer: string }) => {
            buffer = res.buffer;
        });
        assert.match(buffer, /First service starting/);
        assert.match(buffer, /Second service starting/);
        terminals[0].send("First service started\r\n");
        terminals[1].send("Second service started\r\n");
        assert.deepEqual(events, [
            [ "terminalWrite", name, "First service started\r\n" ],
            [ "terminalWrite", name, "Second service started\r\n" ],
        ]);
        terminals[0].finish();
        assert.equal(Terminal.getTerminals(name).length, 1, "One service exiting must not unregister the other");
    } finally {
        terminals.forEach(terminal => terminal.finish());
    }
});

test("service logs replay before live output and stay isolated across viewers, services, and combined logs", async (t) => {
    const server = { stacksDir: "/unused-log-test-stacks" } as DockgeServer;
    const stack = new Stack(server, "demo", undefined, undefined, true);
    t.mock.method(Stack, "getStack", async () => stack);
    const started = new Set<Terminal>();
    t.mock.method(Terminal.prototype, "start", function (this: Terminal) {
        if (!started.has(this)) {
            started.add(this);
            TestTerminal.prototype.send.call(this, "first live line\r\n");
        }
    });
    const combined = new TestTerminal(server, getCombinedTerminalName("", "demo"), "docker", [], "/");
    const events: unknown[][] = [];
    const makeViewer = (id: string, service: string, userID = 1) => {
        const socket = { id,
            endpoint: "",
            userID,
            emitAgent: (...args: unknown[]) => events.push([ id, ...args ]) } as unknown as DockgeSocket;
        const agent = new AgentSocket();
        new TerminalSocketHandler().create(socket, server, agent);
        return {
            socket,
            agent,
            join: () => new Promise<{ ok: boolean; buffer?: string; msg?: string }>(resolve => {
                agent.call("containerLogs", "demo", service, res => {
                    events.push([ id, "history", res ]);
                    resolve(res);
                });
            }),
        };
    };
    const first = makeViewer("first", "included");
    const second = makeViewer("second", "included");
    const other = makeViewer("other", "another");
    combined.join(first.socket);
    t.after(() => {
        combined.finish();
        for (const terminal of started) {
            TestTerminal.prototype.finish.call(terminal);
        }
    });
    assert.equal((await first.join()).buffer, "");
    assert.deepEqual(events.slice(0, 2).map(event => event[1]), [ "history", "terminalWrite" ]);
    const name = getContainerLogsTerminalName("", "demo", "included");
    const terminal = Terminal.getTerminal(name)!;
    assert.deepEqual(Reflect.get(terminal, "args"), [ "compose", "logs", "--follow", "--tail", "100", "--", "included" ]);
    assert.equal(Reflect.get(terminal, "cwd"), "/unused-log-test-stacks/demo");
    assert.equal(terminal.enableKeepAlive, true);
    assert.equal((await second.join()).buffer, "first live line\r\n");
    assert.equal(started.size, 1, "Reopening must reuse the stream");
    await other.join();
    assert.equal(started.size, 2);
    assert.equal((await makeViewer("anonymous", "included", 0).join()).ok, false);
    assert.equal((await makeViewer("invalid", "bad\nservice").join()).ok, false);
    events.length = 0;
    TestTerminal.prototype.send.call(terminal, "selected service only\r\n");
    assert.deepEqual(events.map(event => event[0]), [ "first", "second" ]);
    let left = false;
    first.agent.call("leaveContainerLogs", "demo", "included", res => left = res.ok);
    assert.equal(left, true);
    events.length = 0;
    TestTerminal.prototype.send.call(terminal, "second viewer remains\r\n");
    combined.send("combined logs remain\r\n");
    assert.deepEqual(events, [
        [ "second", "terminalWrite", name, "second viewer remains\r\n" ],
        [ "first", "terminalWrite", combined.name, "combined logs remain\r\n" ],
    ]);
    assert.notEqual(getContainerLogsTerminalName("", "demo-a", "b"), getContainerLogsTerminalName("", "demo", "a-b"));
    assert.notEqual(getContainerLogsTerminalName("remote", "demo", "included"), name);
});
