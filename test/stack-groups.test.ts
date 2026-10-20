import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Server } from "socket.io";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { reactive } from "vue";
import { StackGroups } from "../backend/stack-groups";
import { resolveGroupMember, splitGroupReference, stackGroupEndpoint, parseStackGroupEndpoint } from "../common/stack-groups";
import { AgentSocket } from "../common/agent-socket";
import { Agent } from "../backend/models/agent";
import { StackGroupSocketHandler, validateGroupProxy } from "../backend/agent-socket-handlers/stack-group-socket-handler";
import { StackGroupTransport } from "../backend/stack-group-transport";
import { getComposeTerminalName, getContainerExecTerminalName } from "../common/util-common";
import type { LooseObject } from "../common/util-common";
import type { DockgeServer } from "../backend/dockge-server";
import type { DockgeSocket } from "../backend/util-server";
import groupView from "../frontend/src/stack-groups-view.js";

async function store(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-groups-test-"));
    t.after(() => fs.rm(directory, { recursive: true,
        force: true }));
    return { directory,
        groups: new StackGroups(directory) };
}

class Viewer extends EventEmitter {
    id = "viewer";
    userID = 1;
    connected = true;
    endpoint = "owner:5001";
    output: unknown[][] = [];
    emitAgent(event: string, ...args: unknown[]) {
        this.output.push([ event, ...args ]);
    }

    socket() {
        return this as unknown as DockgeSocket;
    }
}

async function controller(t: TestContext) {
    const { directory, groups } = await store(t);
    const socket = new Viewer();
    const events = new AgentSocket();
    const agents = { "device:5001": { endpoint: "device:5001",
        name: "Owner robot",
        url: "http://device:5001",
        username: "owner-user",
        password: "owner-secret" } as Agent };
    t.mock.method(Agent, "getAgentList", async () => agents);
    new StackGroupSocketHandler().create(socket.socket(), { stackGroups: groups,
        stacksDir: directory } as DockgeServer, events);
    t.after(() => socket.emit("disconnect"));
    const request = (input: object): Promise<LooseObject> => new Promise(resolve => events.call("stackGroupRequest", input, resolve));
    return { groups,
        socket,
        request,
        agents };
}

test("groups.yaml supports atomic CRUD, simultaneous saves and preserved comments", async t => {
    const { directory, groups } = await store(t);
    assert.deepEqual(await groups.list(), {});
    await fs.writeFile(path.join(directory, "groups.yaml"), "# robot groups\nOriginal:\n  - Current:core\n");
    await Promise.all([ groups.save("Robot A", [ "Jetson:vision" ]), groups.save("Robot B", [ "Current:core" ]) ]);
    await groups.save("Renamed", [ "Current:core", "Jetson:vision" ], "Original");
    await groups.delete("Robot B");
    const source = await fs.readFile(path.join(directory, "groups.yaml"), "utf8");
    assert.match(source, /# robot groups/);
    assert.deepEqual(parse(source), { "Robot A": [ "Jetson:vision" ],
        Renamed: [ "Current:core", "Jetson:vision" ] });
    assert.deepEqual((await fs.readdir(directory)).sort(), [ "groups.yaml" ]);
});

test("invalid group files and members are rejected without overwriting the file", async t => {
    const { directory, groups } = await store(t);
    await assert.rejects(groups.save("../escape", [ "Current:core" ]), /Invalid/);
    await assert.rejects(groups.save("Robot", [ "Current:../core" ]), /Agent:Stack/);
    await assert.rejects(groups.save("Robot", [ "Current:core", "Current:core" ]), /once/);
    const filename = path.join(directory, "groups.yaml");
    await fs.writeFile(filename, "Robot: [broken\n");
    await assert.rejects(groups.save("New", []), /groups.yaml/);
    assert.equal(await fs.readFile(filename, "utf8"), "Robot: [broken\n");
});

test("friendly names resolve in the owner's directory and Current always means the owner", () => {
    const directory = [{ name: "Robot",
        endpoint: "10.0.0.2:5001" }, { name: "Jetson",
        endpoint: "[::1]:5001" }];
    assert.equal(resolveGroupMember("Robot:core", directory).endpoint, "10.0.0.2:5001");
    assert.equal(resolveGroupMember("Current:RobotCore", directory).endpoint, "");
    assert.equal(resolveGroupMember("[::1]:5001:vision", directory).endpoint, "[::1]:5001");
    assert.equal(splitGroupReference("10.0.0.2:5001:core").stackName, "core");
    assert.throws(() => resolveGroupMember("Viewer alias:core", directory), /not found/);
    assert.throws(() => resolveGroupMember("Robot:core", [ ...directory, { name: "Robot",
        endpoint: "other:5001" }]), /ambiguous/);
});

test("group endpoint namespaces safely round-trip names and isolate identical service names", () => {
    const first = stackGroupEndpoint("owner:5001", "Robot 🤖", "Current:core");
    assert.match(first, /^[\x00-\x7f]+$/);
    assert.deepEqual(parseStackGroupEndpoint(first), { owner: "owner:5001",
        group: "Robot 🤖",
        member: "Current:core" });
    assert.notEqual(first, stackGroupEndpoint("another:5001", "Robot 🤖", "Current:core"));
    assert.notEqual(first, stackGroupEndpoint("owner:5001", "Robot 🤖", "Jetson:core"));
    assert.equal(parseStackGroupEndpoint("normal:5001"), null);
    assert.equal(parseStackGroupEndpoint("stack-group:%invalid"), null);
});

test("group proxy rejects unrelated stacks, terminals, shells and arbitrary commands", () => {
    const member = resolveGroupMember("Current:core", []);
    const endpoint = stackGroupEndpoint("", "Robot", member.reference);
    validateGroupProxy(endpoint, member, "stopStack", [ "core" ]);
    validateGroupProxy(endpoint, member, "terminalJoin", [ getComposeTerminalName(endpoint, "core") ]);
    validateGroupProxy(endpoint, member, "terminalInput", [ getContainerExecTerminalName(endpoint, "core", "app", 0), "ls\n" ]);
    assert.throws(() => validateGroupProxy(endpoint, member, "downStack", [ "other" ]));
    assert.throws(() => validateGroupProxy(endpoint, member, "terminalInput", [ "console", "anything" ]));
    assert.throws(() => validateGroupProxy(endpoint, member, "terminalJoin", [ getComposeTerminalName(endpoint, "other") ]));
    assert.throws(() => validateGroupProxy(endpoint, member, "interactiveTerminal", [ "core", "app", "arbitrary command" ]));
    assert.throws(() => validateGroupProxy(endpoint, member, "saveStack", [ "core" ]));
});

test("owner group actions preserve Stop/Down/Kill semantics and report individual failures", async t => {
    const { groups, request } = await controller(t);
    await groups.save("Robot", [ "Current:core", "Owner robot:core" ]);
    const calls: { endpoint: string; event: string; args: unknown[] }[] = [];
    t.mock.method(StackGroupTransport.prototype, "call", async (_name, member, _agents, event, args) => {
        calls.push({ endpoint: member.endpoint,
            event,
            args });
        if (member.endpoint) {
            throw new Error("Agent unavailable");
        }
        return { ok: true };
    });
    for (const event of [ "startStack", "stopStack", "downStack", "killStack", "pullStack", "restartStack" ]) {
        const result = await request({ action: "operate",
            name: "Robot",
            event });
        assert.equal(result.ok, false);
        assert.deepEqual(result.results.map(item => item.ok), [ true, false ]);
        assert.deepEqual(calls.slice(-2).map(call => call.event), [ event, event ]);
        assert.deepEqual(calls.slice(-2).map(call => call.args), [[ "core" ], [ "core" ]]);
    }
    assert.equal(calls[1].endpoint, "device:5001");
});

test("snapshots keep containers separate across agents and cache resolved configuration", async t => {
    const { groups, request } = await controller(t);
    await groups.save("Robot", [ "Current:core", "Owner robot:core", "Owner robot:vision" ]);
    let configRequests = 0;
    let statsRequests = 0;
    t.mock.method(StackGroupTransport.prototype, "call", async (_name, member, _agents, event, args) => {
        if (event === "dockerStats") {
            statsRequests++;
            return { ok: true,
                dockerStats: { app: { CPUPerc: "1%" } } };
        }
        if (args[1]) {
            configRequests++;
        }
        return { ok: true,
            stack: { name: member.stackName,
                isManagedByDockge: true },
            serviceStatusList: { app: [{ name: "app",
                state: "running" }] },
            ...(args[1] ? { config: { services: { app: { image: "example/app" } } } } : {}) };
    });
    const first = await request({ action: "snapshot",
        name: "Robot" });
    assert.equal(first.members.length, 3);
    assert.equal(first.members[1].agentName, "Owner robot");
    assert.equal(first.members[1].endpoint, "device:5001");
    assert.equal(configRequests, 3);
    assert.equal(statsRequests, 2, "Read Docker stats once per device");
    const second = await request({ action: "snapshot",
        name: "Robot" });
    assert.equal(configRequests, 3);
    assert.equal(second.members[2].config.services.app.image, "example/app");
    await request({ action: "snapshot",
        name: "Robot",
        refresh: true });
    assert.equal(configRequests, 6);
});

test("unknown references cannot accidentally operate on the current agent", async t => {
    const { groups, request, socket } = await controller(t);
    await groups.save("Robot", [ "Missing:core", "Current:core" ]);
    const calls: string[] = [];
    t.mock.method(StackGroupTransport.prototype, "call", async (_name, member) => {
        calls.push(member.reference);
        return { ok: true };
    });
    const result = await request({ action: "operate",
        name: "Robot",
        event: "downStack" });
    assert.equal(result.results[0].ok, false);
    assert.deepEqual(calls, [ "Current:core" ]);
    socket.userID = 0;
    assert.equal((await request({ action: "list" })).ok, false);
});

test("group saves reject duplicate aliases for the same physical stack", async t => {
    const { request } = await controller(t);
    const result = await request({ action: "save",
        name: "Robot",
        members: [ "Owner robot:core", "device:5001:core" ] });
    assert.equal(result.ok, false);
    assert.match(result.msg, /once/);
});

test("nested agent transport uses the owner's credentials and isolates terminal output", async t => {
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const endpoint = `127.0.0.1:${port}`;
    const viewer = new Viewer();
    const transport = new StackGroupTransport({} as DockgeServer, viewer.socket());
    const agents = { [endpoint]: { endpoint,
        name: "Owner robot",
        url: `http://${endpoint}`,
        username: "owner-user",
        password: "owner-secret" } as Agent };
    const received: string[] = [];
    io.on("connection", socket => {
        socket.on("login", (credentials, callback) => {
            assert.deepEqual(credentials, { username: "owner-user",
                password: "owner-secret" });
            callback({ ok: true });
        });
        socket.on("agent", (target, event, name, callback) => {
            assert.equal(target, socket.handshake.headers.endpoint);
            received.push(target);
            socket.emit("agent", "terminalWrite", getComposeTerminalName(target, name), "output");
            callback({ ok: true });
        });
    });
    t.after(async () => {
        transport.close();
        await new Promise<void>(resolve => io.close(() => resolve()));
    });
    for (const stackName of [ "core", "vision" ]) {
        const member = resolveGroupMember(`Owner robot:${stackName}`, Object.values(agents));
        await transport.call("Robot", member, agents, "startStack", [ stackName ]);
    }
    assert.equal(new Set(received).size, 2);
    await delay(10);
    assert.equal(viewer.output.filter(event => event[0] === "terminalWrite").length, 2);
    assert.notEqual(viewer.output.filter(event => event[0] === "terminalWrite")[0][1], viewer.output.filter(event => event[0] === "terminalWrite")[1][1]);

    // Rebinding the same friendly name must discard its old connection.
    const replacementHTTP = http.createServer();
    const replacementIO = new Server(replacementHTTP);
    await new Promise<void>(resolve => replacementHTTP.listen(0, "127.0.0.1", resolve));
    const replacementEndpoint = `127.0.0.1:${(replacementHTTP.address() as { port: number }).port}`;
    let replacementCalls = 0;
    replacementIO.on("connection", socket => {
        socket.on("login", (_credentials, callback) => callback({ ok: true }));
        socket.on("agent", (_target, _event, _stack, callback) => {
            replacementCalls++;
            callback({ ok: true });
        });
    });
    t.after(async () => {
        transport.close();
        await new Promise<void>(resolve => replacementIO.close(() => resolve()));
    });
    const replacementAgents = { [replacementEndpoint]: { ...agents[endpoint],
        endpoint: replacementEndpoint,
        url: `http://${replacementEndpoint}` } as Agent };
    const rebound = resolveGroupMember("Owner robot:core", Object.values(replacementAgents));
    await transport.call("Robot", rebound, replacementAgents, "stopStack", [ "core" ]);
    assert.equal(replacementCalls, 1);
    assert.equal(received.length, 2, "The old device must not receive another command");
});

test("the group view sorts all member containers and preserves their action targets", t => {
    const original = globalThis.localStorage;
    globalThis.localStorage = {} as Storage;
    t.after(() => {
        globalThis.localStorage = original;
    });
    const calls: unknown[][] = [];
    const instance = { ...groupView.data.call({ $route: { params: { groupName: "Robot",
        endpoint: "owner:5001" } } }),
    $root: { emitAgent: (...args) => calls.push(args),
        toastRes() {} } };
    for (const [ name, method ] of Object.entries(groupView.methods)) {
        instance[name] = method.bind(instance);
    }
    instance.members = [
        { reference: "Current:core",
            agentName: "Current",
            stackName: "core",
            stack: { isManagedByDockge: true },
            config: { services: { app: {} } },
            serviceStatusList: { app: [{ state: "running" }] } },
        { reference: "Owner robot:core",
            agentName: "Owner robot",
            stackName: "core",
            stack: { isManagedByDockge: true },
            config: { services: { app: {} } },
            serviceStatusList: { app: [{ state: "restarting" }] } },
    ];
    const rows = groupView.computed.rows.call(instance);
    assert.equal(rows[0].member.reference, "Owner robot:core");
    assert.notEqual(rows[0].key, rows[1].key);
    instance.request = payload => {
        calls.push(payload);
        return new Promise(() => {});
    };
    instance.runServiceOperation("stopService", rows[0]);
    assert.equal(calls[0].member, "Owner robot:core");
    assert.equal(calls[0].event, "stopService");
    assert.deepEqual(calls[0].args, [ "core", "app" ]);
    assert.equal(groupView.computed.groupState.call(instance), "Running");
});

test("losing the owner connection releases pending group requests", async () => {
    const socket = new EventEmitter();
    const root = { getSocket: () => socket,
        socketIO: { connected: true },
        agentStatusList: { "owner:5001": "online" },
        emitAgent() {} };
    const pending = groupView.methods.request.call({ owner: "owner:5001",
        $root: root,
        $t: text => text }, { action: "operate" }, 0);
    socket.emit("agentStatus", { endpoint: "owner:5001",
        status: "offline" });
    await assert.rejects(pending, /offline/);
    assert.equal(socket.listenerCount("agentStatus"), 0);
    assert.equal(socket.listenerCount("disconnect"), 0);
});

test("individual group service controls unlock with Vue reactive state", async () => {
    let refreshed = 0;
    const state = reactive({ stopping: false,
        serviceOperations: {},
        serviceOperationRequest: 0,
        disposed: false,
        name: "Robot",
        request: async () => ({ ok: true }),
        $root: { toastRes() {} },
        requestSnapshot: () => refreshed++ });
    await groupView.methods.runServiceOperation.call(state, "stopService", { key: "row",
        name: "app",
        member: { reference: "Current:core",
            stackName: "core" } });
    assert.deepEqual(Object.keys(state.serviceOperations), []);
    assert.equal(refreshed, 1);
});

test("membership options come from the owner's agent registry", async t => {
    const { request } = await controller(t);
    t.mock.method(StackGroupTransport.prototype, "call", async () => ({ ok: true,
        stacks: [ "core" ] }));
    const result = await request({ action: "options" });
    assert.equal(result.choices[0].stacks[0].reference, "Current:core");
    assert.equal(result.choices[1].stacks[0].reference, "Owner robot:core");
    assert.equal(result.choices[1].endpoint, "device:5001");
});
