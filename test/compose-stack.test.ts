import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import childProcessAsync from "promisify-child-process";
import { Stack } from "../backend/stack";
import { Terminal } from "../backend/terminal";
import { DockgeServer } from "../backend/dockge-server";
import { DockgeSocket } from "../backend/util-server";
import { DockerSocketHandler } from "../backend/agent-socket-handlers/docker-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import { CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";

/** Build a saved include-based stack without starting Docker or a terminal. */
async function fixture(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-stack-test-"));
    t.after(() => fs.rm(directory, {
        recursive: true,
        force: true,
    }));
    const stackDirectory = path.join(directory, "test");
    await fs.mkdir(stackDirectory);
    await fs.writeFile(path.join(stackDirectory, "compose.yaml"), "include:\n  - ../shared/compose.yaml\n");
    await fs.writeFile(path.join(stackDirectory, "compose.override.yaml"), "services: {}\n");
    return {
        server: { stacksDir: directory } as DockgeServer,
        stackDirectory,
    };
}

test("Stop runs stop and Stop & Inactive runs down regardless of the recorded status", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    const execution = t.mock.method(Terminal, "exec", async () => 0);
    const stack = new Stack(server, "test");
    const socket = { endpoint: "" } as DockgeSocket;
    for (const command of [ "stop", "down" ] as const) {
        for (const status of [ UNKNOWN, CREATED_FILE, CREATED_STACK, RUNNING, EXITED ]) {
            Object.assign(stack, { _status: status });
            assert.equal(await stack[command](socket), 0);
            const args = execution.mock.calls.at(-1)!.arguments;
            assert.equal(args[3], "docker");
            assert.deepEqual(args[4], [ "compose", "--progress", "plain", "-f", "compose.yaml", "-f", "compose.override.yaml", command ]);
            assert.equal(args[5], stackDirectory);
            assert.equal(args[6], true, "Both shutdown actions must interrupt a pending Compose operation");
        }
    }
});

test("a custom Compose project name updates its managed folder instead of creating a duplicate", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({
        stdout: JSON.stringify([{
            Name: "custom-project",
            Status: "created(20),running(1)",
            ConfigFiles: [ "compose.yaml", "compose.override.yaml" ].map(file => path.join(stackDirectory, file)).join(","),
        }]),
    }) as ReturnType<typeof childProcessAsync.spawn>);

    const list = await Stack.getStackList(server);
    assert.equal(list.size, 1);
    assert.equal(list.get("test")?.status, RUNNING);
    assert.equal(list.get("test")?.isManagedByDockge, true);
    const stack = new Stack(server, "test");
    await stack.updateStatus();
    assert.equal(stack.status, RUNNING);
});

test("service polling keeps container state separate from health and updates stack status", async (t) => {
    const { server } = await fixture(t);
    const stack = new Stack(server, "test");
    const rows = [
        { Service: "included",
            State: "running",
            Health: "starting",
            Name: "included-1" },
        { Service: "included",
            State: "running",
            Health: "unhealthy",
            Name: "included-2" },
        { Service: "waiting",
            State: "created",
            Health: "",
            Name: "waiting-1" },
    ];
    let stdout = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    const execution = t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({ stdout }) as ReturnType<typeof childProcessAsync.spawn>);
    const services = await stack.getServiceStatusList();
    assert.equal(stack.status, RUNNING);
    assert.deepEqual(services.get("included"), [
        { status: "starting",
            state: "running",
            health: "starting",
            name: "included-1" },
        { status: "unhealthy",
            state: "running",
            health: "unhealthy",
            name: "included-2" },
    ]);
    assert.deepEqual(execution.mock.calls[0].arguments[1], [ "compose", "-f", "compose.yaml", "-f", "compose.override.yaml", "ps", "--all", "--format", "json" ]);
    // Older Compose releases return a JSON array instead of JSON lines.
    stdout = JSON.stringify(rows);
    assert.deepEqual(await stack.getServiceStatusList(), services);
    stdout = JSON.stringify(rows, null, 2);
    assert.deepEqual(await stack.getServiceStatusList(), services);
    stdout = "truncated JSON";
    await assert.rejects(stack.getServiceStatusList());
    assert.equal(stack.status, RUNNING);
    stdout = "";
    assert.equal((await stack.getServiceStatusList()).size, 0);
    assert.equal(stack.status, CREATED_FILE);
});

test("failed polling reports an error instead of reporting running containers as absent", async (t) => {
    const { server } = await fixture(t);
    const stack = new Stack(server, "test");
    Object.assign(stack, { _status: RUNNING });
    t.mock.method(childProcessAsync, "spawn", async () => {
        throw new Error("Docker is temporarily unavailable");
    });
    await assert.rejects(stack.getServiceStatusList(), /temporarily unavailable/);
    assert.equal(stack.status, RUNNING);
});

test("multi-service startup exposes states and logs while Up waits, and Stop cancels it", async (t) => {
    const { server } = await fixture(t);
    Object.assign(server, { sendStackList: () => {} });
    const agent = new AgentSocket();
    const socket = { id: "bulk-start",
        userID: 1,
        endpoint: "",
        emitAgent: () => {} } as unknown as DockgeSocket;
    new DockerSocketHandler().create(socket, server, agent);
    const commands: string[][] = [];
    const names = new Set<string>();
    let started: () => void;
    const starting = new Promise<void>(resolve => {
        started = resolve;
    });
    t.mock.method(Terminal.prototype, "start", function (this: Terminal) {
        const args = Reflect.get(this, "args") as string[];
        commands.push(args);
        names.add(this.name);
        const finish = Reflect.get(this, "exit");
        if (args.includes("up")) {
            Object.assign(this, { _ptyProcess: {
                write: (input: string) => {
                    assert.equal(input, "\x03");
                    finish({ exitCode: 130 });
                },
            } });
            started();
        } else if (args.includes("stop")) {
            finish({ exitCode: 0 });
        }
    });
    t.after(() => {
        for (const name of names) {
            const terminal = Terminal.getTerminal(name);
            if (terminal) {
                Reflect.get(terminal, "exit")({ exitCode: 0 });
            }
        }
    });
    t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({
        stdout: JSON.stringify([
            { Service: "docker_manager",
                State: "running",
                Health: "starting",
                Name: "docker_manager" },
            { Service: "ready",
                State: "running",
                Health: "healthy",
                Name: "ready" },
            { Service: "waiting",
                State: "created",
                Health: "",
                Name: "waiting" },
        ], null, 2),
    }) as ReturnType<typeof childProcessAsync.spawn>);
    let startReply;
    const up = agent.eventList.get("startStack")!("test", (res: unknown) => {
        startReply = res;
    });
    await starting;
    let statusReply;
    await agent.eventList.get("serviceStatusList")!("test", (res: unknown) => {
        statusReply = res;
    });
    assert.equal(startReply, undefined, "Up is still waiting on dependency health");
    assert.equal(statusReply.stackStatus, RUNNING);
    assert.equal(statusReply.serviceStatusList.docker_manager[0].state, "running");
    assert.equal(statusReply.serviceStatusList.waiting[0].state, "created");
    assert.equal(commands.some(args => args.includes("logs")), true, "Logs must attach before Up completes");
    let stopReply;
    await agent.eventList.get("stopStack")!("test", (res: unknown) => {
        stopReply = res;
    });
    await up;
    assert.equal(startReply.ok, false);
    assert.match(startReply.msg, /cancelled by Stop/);
    assert.equal(stopReply.ok, true);
    assert.deepEqual(commands.at(-1), [ "compose", "--progress", "plain", "-f", "compose.yaml", "-f", "compose.override.yaml", "stop" ]);
});

test("cached polling clears running status after down and drops vanished external projects", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    let projects = [
        {
            Name: "test",
            Status: "created(1),running(25)",
            ConfigFiles: path.join(stackDirectory, "compose.yaml"),
        },
        {
            Name: "external",
            Status: "running(1)",
            ConfigFiles: "/elsewhere/compose.yaml",
        },
    ];
    t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({
        stdout: JSON.stringify(projects),
    }) as ReturnType<typeof childProcessAsync.spawn>);

    let list = await Stack.getStackList(server);
    assert.equal(list.get("test")?.status, RUNNING);
    assert.equal(list.get("external")?.status, RUNNING);
    list = await Stack.getStackList(server, true);
    assert.equal(list.get("test")?.status, RUNNING);
    assert.equal(list.get("external")?.status, RUNNING);

    // compose down removes the project from docker compose ls entirely.
    projects = [];
    list = await Stack.getStackList(server, true);
    assert.equal(list.get("test")?.status, CREATED_FILE);
    assert.equal(list.has("external"), false);
});

test("a failed project poll preserves the cached running state", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    const poll = t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({
        stdout: JSON.stringify([{
            Name: "test",
            Status: "running(1)",
            ConfigFiles: path.join(stackDirectory, "compose.yaml"),
        }]),
    }) as ReturnType<typeof childProcessAsync.spawn>);
    const list = await Stack.getStackList(server);
    poll.mock.mockImplementation(async () => {
        throw new Error("Docker is temporarily unavailable");
    });
    await assert.rejects(Stack.getStackList(server, true), /temporarily unavailable/);
    assert.equal(list.get("test")?.status, RUNNING);
});
