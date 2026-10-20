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
import { Settings } from "../backend/settings";
import { MainSocketHandler } from "../backend/socket-handlers/main-socket-handler";

/** Build a saved include-based stack without starting Docker or a terminal. */
async function fixture(t: TestContext) {
    t.mock.method(Settings, "get", async () => undefined);
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

test("client info publishes the edit-only Compose setting as a boolean with a disabled default", async (t) => {
    let value: unknown;
    t.mock.method(Settings, "get", async key => key === "showComposeOnlyInEditMode" ? value : undefined);
    for (value of [ undefined, false, true, "true" ]) {
        let info;
        const socket = { emit: (event, data) => {
            assert.equal(event, "info");
            info = data;
        } };
        await DockgeServer.prototype.sendInfo.call({} as DockgeServer, socket as never, true);
        assert.equal(info.showComposeOnlyInEditMode, value === true);
    }
});

test("client info defaults to friendly agent names and preserves an explicit address preference", async (t) => {
    let value: unknown;
    t.mock.method(Settings, "get", async key => key === "showAgentFriendlyNames" ? value : undefined);
    for (value of [ undefined, false, true ]) {
        let info;
        const socket = { emit: (event, data) => info = data };
        await DockgeServer.prototype.sendInfo.call({} as DockgeServer, socket as never, true);
        assert.equal(info.showAgentFriendlyNames, value !== false);
    }
});

test("Stop, Down and Kill run their matching commands regardless of the recorded status", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    const execution = t.mock.method(Terminal, "exec", async () => 0);
    const stack = new Stack(server, "test");
    const socket = { endpoint: "" } as DockgeSocket;
    for (const command of [ "stop", "down", "kill" ] as const) {
        for (const status of [ UNKNOWN, CREATED_FILE, CREATED_STACK, RUNNING, EXITED ]) {
            Object.assign(stack, { _status: status });
            assert.equal(await stack[command](socket), 0);
            const args = execution.mock.calls.at(-1)!.arguments;
            assert.equal(args[3], "docker");
            assert.deepEqual(args[4], [ "compose", "--progress", "plain", command ]);
            assert.equal(args[5], stackDirectory);
            assert.equal(args[6], true, "Shutdown actions must interrupt a pending Compose operation");
        }
    }
});

test("Pull only downloads images even when the stack is running and propagates failures", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    const stack = new Stack(server, "test");
    const socket = { endpoint: "" } as DockgeSocket;
    let exitCode = 0;
    const execution = t.mock.method(Terminal, "exec", async () => exitCode);
    t.mock.method(stack, "updateStatus", async () => {
        assert.fail("Pull must not query status to restart containers");
    });
    for (const status of [ CREATED_FILE, RUNNING, EXITED ]) {
        Object.assign(stack, { _status: status });
        const before = execution.mock.calls.length;
        assert.equal(await stack.pull(socket), 0);
        assert.equal(execution.mock.calls.length, before + 1);
        const args = execution.mock.calls.at(-1)!.arguments;
        assert.deepEqual(args[4], [ "compose", "--progress", "plain", "pull" ]);
        assert.equal(args[5], stackDirectory);
        assert.notEqual(args[6], true);
    }
    exitCode = 1;
    await assert.rejects(stack.pull(socket), /Failed to pull/);
});

test("Pull and Kill socket actions validate input and execute stack or named-service commands", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    let refreshed = 0;
    Object.assign(server, { sendStackList: () => refreshed++ });
    const socket = { userID: 1,
        endpoint: "" } as DockgeSocket;
    const agent = new AgentSocket();
    new DockerSocketHandler().create(socket, server, agent);
    let exitCode = 0;
    const execution = t.mock.method(Terminal, "exec", async () => exitCode);
    for (const command of [ "pull", "kill" ] as const) {
        for (const service of [ false, true ]) {
            const event = command + (service ? "Service" : "Stack");
            const handler = agent.eventList.get(event)!;
            const input = service ? [ "test", "included" ] : [ "test" ];
            const invoke = async (args: unknown[]) => {
                let reply;
                await handler(...args, res => reply = res);
                return reply;
            };
            const before = execution.mock.calls.length;
            socket.userID = 0;
            assert.equal((await invoke(input)).ok, false);
            socket.userID = 1;
            assert.equal((await invoke(service ? [ "test", 42 ] : [ 42 ])).ok, false);
            assert.equal(execution.mock.calls.length, before, "Invalid requests must never execute Docker");
            assert.equal((await invoke(input)).ok, true);
            const args = execution.mock.calls.at(-1)!.arguments;
            assert.deepEqual(args[4], [ "compose", "--progress", "plain", command, ...(service ? [ "included" ] : []) ]);
            assert.equal(args[5], stackDirectory);
            assert.equal(args[6] === true, command === "kill" && !service);
            if (service) {
                assert.match(args[7] as string, /:service:included$/);
            }
            exitCode = 1;
            assert.equal((await invoke(input)).ok, false, "Command failures must reach the caller");
            exitCode = 0;
        }
    }
    assert.equal(refreshed, 4, "Each successful action refreshes stack status");
});

test("a custom Compose project name updates its managed folder instead of creating a duplicate", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    t.mock.method(childProcessAsync, "spawn", (_command, args) => Promise.resolve({
        stdout: args[0] === "ps" ? "" : JSON.stringify([{
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
    assert.deepEqual(execution.mock.calls[0].arguments[1], [ "compose", "ps", "--all", "--format", "json" ]);
    assert.equal(execution.mock.calls[0].arguments[2]?.timeout, 10000);
    assert.equal(execution.mock.calls[0].arguments[2]?.maxBuffer, 10 * 1024 * 1024);
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

test("service polling retains exit codes so failed containers can sort above clean exits", async (t) => {
    const { server } = await fixture(t);
    t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({ stdout: JSON.stringify([
        { Service: "failed",
            State: "exited",
            Health: "",
            Name: "failed-1",
            ExitCode: 1 },
        { Service: "finished",
            State: "exited",
            Health: "",
            Name: "finished-1",
            ExitCode: 0 },
    ]) }) as ReturnType<typeof childProcessAsync.spawn>);
    const services = await new Stack(server, "test").getServiceStatusList();
    assert.equal(Reflect.get(services.get("failed")![0], "exitCode"), 1);
    assert.equal(Reflect.get(services.get("finished")![0], "exitCode"), 0);
});

for (const command of [ "stop", "down", "kill" ] as const) {
    test(`${command} cancels Update between Pull and Up even without a running terminal`, async (t) => {
        const { server } = await fixture(t);
        const stack = new Stack(server, "test");
        const socket = { endpoint: "" } as DockgeSocket;
        const execution = t.mock.method(Terminal, "exec", async () => 0);
        let releaseStatus: () => void;
        let statusStarted: () => void;
        const queryingStatus = new Promise<void>(resolve => {
            statusStarted = resolve;
        });
        t.mock.method(stack, "updateStatus", async () => {
            statusStarted();
            await new Promise<void>(resolve => {
                releaseStatus = resolve;
            });
            // This snapshot was taken before Stop completed.
            Object.assign(stack, { _status: RUNNING });
        });
        const update = stack.update(socket);
        const cancelled = assert.rejects(update, /cancelled by a shutdown action/);
        await queryingStatus;
        await stack[command](socket);
        releaseStatus!();
        await cancelled;
        const commands = execution.mock.calls.map(call => (call.arguments[4] as string[]).at(-1));
        assert.deepEqual(commands, [ "pull", command ], "Update must not run Up after shutdown");
    });
}

test("successful Updates can repeat and failed Updates release their operation marker", async (t) => {
    const { server } = await fixture(t);
    const stack = new Stack(server, "test");
    const socket = { endpoint: "" } as DockgeSocket;
    const execution = t.mock.method(Terminal, "exec", async () => 0);
    const status = t.mock.method(stack, "updateStatus", async () => {
        Object.assign(stack, { _status: RUNNING });
    });
    assert.equal(await stack.update(socket), 0);
    assert.equal(await stack.update(socket), 0);
    assert.equal(execution.mock.calls.length, 4);
    status.mock.mockImplementation(async () => {
        throw new Error("Status unavailable");
    });
    await assert.rejects(stack.update(socket), /Status unavailable/);
    status.mock.mockImplementation(async () => {
        Object.assign(stack, { _status: CREATED_FILE });
    });
    assert.equal(await stack.update(socket), 0);
    assert.equal(execution.mock.calls.length, 6, "An inactive stack is pulled without being started");
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
        if (args.includes("up") && (Reflect.get(this, "operationName") as string).includes(":service:")) {
            finish({ exitCode: 0 });
        } else if (args.includes("up")) {
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
    let serviceReply;
    await agent.eventList.get("startService")!("test", "waiting", (res: unknown) => {
        serviceReply = res;
    });
    assert.equal(serviceReply.ok, true, "An individual service must start while bulk Up is waiting");
    assert.equal(startReply, undefined, "Starting a service must not cancel the rest of the stack startup");
    assert.equal(commands.some(args => args.join(" ") === "compose --progress plain up -d waiting"), true);
    let stopReply;
    await agent.eventList.get("stopStack")!("test", (res: unknown) => {
        stopReply = res;
    });
    await up;
    assert.equal(startReply.ok, false);
    assert.match(startReply.msg, /cancelled by a shutdown action/);
    assert.equal(stopReply.ok, true);
    assert.deepEqual(commands.at(-1), [ "compose", "--progress", "plain", "stop" ]);
});

test("runtime commands preserve Compose file discovery and environment file selection", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    await fs.writeFile(path.join(server.stacksDir, "global.env"), "GLOBAL=value\n");
    await fs.writeFile(path.join(stackDirectory, ".env"), "COMPOSE_FILE=compose.yaml:compose.production.yaml\n");
    const stack = new Stack(server, "test");
    assert.deepEqual(stack.getComposeOptions("up", "-d", "--remove-orphans"), [
        "compose", "--env-file", "../global.env", "--env-file", "./.env",
        "--progress", "plain", "up", "-d", "--remove-orphans",
    ]);
    assert.deepEqual(stack.getComposeOptions("ps", "--all", "--format", "json"), [
        "compose", "--env-file", "../global.env", "--env-file", "./.env",
        "ps", "--all", "--format", "json",
    ]);
});

test("the editors choose default Compose filenames in the same order as Docker Compose", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    await fs.rm(path.join(stackDirectory, "compose.yaml"));
    await fs.writeFile(path.join(stackDirectory, "compose.yml"), "services: {}\n");
    await fs.writeFile(path.join(stackDirectory, "docker-compose.yaml"), "services: {}\n");
    await fs.writeFile(path.join(stackDirectory, "compose.override.yml"), "# preferred overrides\n");
    const stack = new Stack(server, "test");
    assert.equal(Reflect.get(stack, "_composeFileName"), "compose.yml");
    assert.equal(stack.composeOverrideYAML, "# preferred overrides\n");
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
    t.mock.method(childProcessAsync, "spawn", (_command, args) => Promise.resolve({
        stdout: args[0] === "ps" ? "" : JSON.stringify(projects),
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
    const poll = t.mock.method(childProcessAsync, "spawn", (_command, args) => Promise.resolve({
        stdout: args[0] === "ps" ? "" : JSON.stringify([{
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

test("stack lists expose failures for unopened custom-named projects and clear them after recovery", async t => {
    const { server, stackDirectory } = await fixture(t);
    let rows = [
        { project: "custom-project",
            state: "running",
            health: "healthy",
            exitCode: 0 },
        { project: "custom-project",
            state: "exited",
            health: "",
            exitCode: 1 },
    ];
    let inspectFailed = false;
    t.mock.method(childProcessAsync, "spawn", async (_command, args) => {
        if (args[0] === "ps") {
            return { stdout: "123456789abc\n23456789abcd" } as Awaited<ReturnType<typeof childProcessAsync.spawn>>;
        }
        if (args[0] === "inspect") {
            if (inspectFailed) {
                throw new Error("Docker status temporarily unavailable");
            }
            return { stdout: rows.map(row => JSON.stringify(row)).join("\n") } as Awaited<ReturnType<typeof childProcessAsync.spawn>>;
        }
        return { stdout: JSON.stringify([{ Name: "custom-project",
            Status: "running(1),exited(1)",
            ConfigFiles: path.join(stackDirectory, "compose.yaml") }]) } as Awaited<ReturnType<typeof childProcessAsync.spawn>>;
    });
    let stack = (await Stack.getStackList(server)).get("test")!;
    assert.equal(stack.status, RUNNING, "Failure indicators must not change stack control semantics");
    assert.equal(stack.errorCount, 1);
    assert.equal(Reflect.get(stack.toSimpleJSON("agent:5001"), "errorCount"), 1);
    inspectFailed = true;
    stack = (await Stack.getStackList(server, true)).get("test")!;
    assert.equal(stack.errorCount, 1, "Failed status reads must not clear known errors");
    inspectFailed = false;
    rows = rows.map(row => ({ ...row,
        state: "running",
        health: "healthy",
        exitCode: 0 }));
    stack = (await Stack.getStackList(server, true)).get("test")!;
    assert.equal(stack.errorCount, 0);
});

test("service polling counts failed replicas while keeping running controls and clears errors on down", async t => {
    const { server } = await fixture(t);
    const stack = new Stack(server, "test");
    let rows = [
        { Service: "app",
            State: "running",
            Health: "healthy",
            Name: "app-1",
            ExitCode: 0 },
        { Service: "app",
            State: "exited",
            Health: "",
            Name: "app-2",
            ExitCode: 1 },
    ];
    t.mock.method(childProcessAsync, "spawn", async () => ({ stdout: rows.map(row => JSON.stringify(row)).join("\n") }) as Awaited<ReturnType<typeof childProcessAsync.spawn>>);
    await stack.getServiceStatusList();
    assert.equal(stack.status, RUNNING);
    assert.equal(stack.errorCount, 1);
    rows = [];
    await stack.getServiceStatusList();
    assert.equal(stack.errorCount, 0);
    assert.equal(stack.status, CREATED_FILE);
});

test("signal exit snapshots inspect OOM state and carry the target device's ignored-code policy", async t => {
    const { server } = await fixture(t);
    let ignored = [ 137, 143 ];
    t.mock.method(Settings, "get", async () => ignored);
    let oomKilled = false;
    let inspectFailed = false;
    const execution = t.mock.method(childProcessAsync, "spawn", async (_command, args) => {
        if (inspectFailed) {
            throw new Error("Inspection temporarily unavailable");
        }
        return { stdout: args[0] === "inspect" ? JSON.stringify({ project: "test",
            state: "exited",
            exitCode: 137,
            health: "",
            oomKilled })
            : JSON.stringify([{ ID: "123456789abc",
                Service: "app",
                State: "exited",
                Health: "",
                Name: "app-1",
                ExitCode: 137 }]) } as Awaited<ReturnType<typeof childProcessAsync.spawn>>;
    });
    const stack = new Stack(server, "test");
    let services = await stack.getServiceStatusList();
    assert.equal(stack.errorCount, 0);
    assert.equal(Reflect.get(services.get("app")![0], "exitCodeIgnored"), true);
    assert.equal(Reflect.get(services.get("app")![0], "oomKilled"), false);
    assert.deepEqual(execution.mock.calls[1].arguments[1].slice(-1), [ "123456789abc" ]);
    oomKilled = true;
    services = await stack.getServiceStatusList();
    assert.equal(stack.errorCount, 1);
    assert.equal(Reflect.get(services.get("app")![0], "oomKilled"), true);
    inspectFailed = true;
    await assert.rejects(stack.getServiceStatusList(), /temporarily unavailable/);
    assert.equal(stack.errorCount, 1);
    inspectFailed = false;
    oomKilled = false;
    ignored = [];
    services = await stack.getServiceStatusList();
    assert.equal(stack.errorCount, 1);
    assert.equal(Reflect.get(services.get("app")![0], "exitCodeIgnored"), false);
});

test("settings RPC validates ignored exit codes before side effects and persists normalized lists", async t => {
    const { server } = await fixture(t);
    const events = new Map();
    const socket = { userID: 1,
        on: (event, handler) => events.set(event, handler) } as unknown as DockgeSocket;
    Object.assign(server, { sendInfo: async () => {} });
    new MainSocketHandler().create(socket, server);
    let stored = {};
    t.mock.method(Settings, "getSettings", async () => stored);
    const saved = [];
    t.mock.method(Settings, "setSettings", async (_type, data) => {
        saved.push(data.ignoredContainerExitCodes);
    });
    const env = path.join(server.stacksDir, "global.env");
    await fs.writeFile(env, "KEEP=this\n");
    let reply;
    await events.get("getSettings")(result => reply = result);
    assert.deepEqual(reply.data.ignoredContainerExitCodes, [ 137, 143 ]);
    stored = { ignoredContainerExitCodes: [] };
    await events.get("getSettings")(result => reply = result);
    assert.deepEqual(reply.data.ignoredContainerExitCodes, []);
    await events.get("setSettings")({ ignoredContainerExitCodes: "256" }, undefined, result => reply = result);
    assert.equal(reply.ok, false);
    assert.equal(saved.length, 0);
    assert.equal(await fs.readFile(env, "utf8"), "KEEP=this\n");
    await events.get("setSettings")({ ignoredContainerExitCodes: "137,143,2,2" }, undefined, result => reply = result);
    assert.equal(reply.ok, true);
    assert.deepEqual(saved, [[ 137, 143, 2 ]]);
    socket.userID = 0;
    await events.get("setSettings")({ ignoredContainerExitCodes: [] }, undefined, result => reply = result);
    assert.equal(reply.ok, false);
    assert.equal(saved.length, 1);
});
