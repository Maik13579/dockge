import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { BulkContainers, BulkContainer, isDockgeContainer, isManagedContainer } from "../backend/bulk-containers";
import { BulkContainerSocketHandler } from "../backend/agent-socket-handlers/bulk-container-socket-handler";
import { Stack } from "../backend/stack";
import { Terminal } from "../backend/terminal";
import { AgentSocket } from "../common/agent-socket";
import { lockContainerOperations, composeCommand } from "../backend/container-operation-lock";
import type { DockgeServer } from "../backend/dockge-server";
import type { DockgeSocket } from "../backend/util-server";
import bulkView from "../frontend/src/bulk-containers-view.js";
import { agentRequest } from "../frontend/src/agent-request.js";
function row(number: number, name: string, state = "running", labels = {}): BulkContainer {
    return { Id: number.toString(16).padStart(64, "0"),
        Name: "/" + name,
        Config: { Hostname: name,
            Image: "example/app:latest",
            Labels: labels },
        State: { Status: state } };
}
const managedLabels = { "com.docker.compose.project": "custom-project",
    "com.docker.compose.project.working_dir": "/opt/stacks/robot" };
function engine(t: TestContext, input?: BulkContainer[], options = {}) {
    const self = row(1, "dockge", "running", { "io.dockge.protected": "true" });
    self.Config.Hostname = "self-host";
    const rows = new Map((input || [ self, row(2, "app", "running", managedLabels), row(3, "old", "exited", managedLabels), row(4, "created", "created"), row(5, "external") ]).map(container => [ container.Id, container ]));
    const calls: string[][] = [];
    const failures = new Set<string>();
    const run = async (args: string[]) => {
        calls.push(args);
        if (args[1] === "ls") {
            return [ ...rows.keys() ].join("\n");
        }
        if (args[1] === "inspect") {
            return JSON.stringify(args.slice(2).map(id => {
                const container = rows.get(id);
                if (!container) {
                    throw new Error("No such container");
                }
                return container;
            }));
        }
        const id = args.at(-1)!;
        if (failures.has(id)) {
            throw new Error("Engine rejected action");
        }
        if (args[1] === "rm") {
            rows.delete(id);
        }
        if (args[1] === "kill") {
            rows.get(id)!.State.Status = "exited";
        }
        if (args[1] === "unpause") {
            rows.get(id)!.State.Status = "running";
        }
        return id;
    };
    const server = { sendStackList: async () => { } } as unknown as DockgeServer;
    t.mock.method(Stack, "getStackList", async () => new Map([[ "robot", { path: "/opt/stacks/robot",
        isManagedByDockge: true } as Stack ]]));
    const service = new BulkContainers(server, { run,
        hostname: "self-host",
        inContainer: true,
        ...options });
    return { service,
        server,
        rows,
        calls,
        failures,
        self };
}
async function finished(service: BulkContainers, token: string) {
    for (let count = 0; count < 1000; count++) {
        const job = service.status(7, token);
        if (job.state !== "running") {
            await delay(0);
            return job;
        }
        await delay(1);
    }
    throw new Error("Bulk job did not finish");
}
test("managed kill and rm filters by managed directory, includes stopped containers, and preserves Dockge", async (t) => {
    const { service, rows, calls, self } = engine(t);
    const preview = await service.preview(7, { scope: "managed",
        remove: true });
    assert.equal(preview.count, 2);
    assert.equal(preview.protectedCount, 1);
    const job = service.execute(7, preview.token);
    assert.equal(service.execute(7, preview.token), job, "Repeated execute requests must not repeat mutations");
    const result = await finished(service, preview.token);
    assert.equal(result.state, "completed");
    assert.equal(result.completed, 2);
    assert.equal(rows.has(self.Id), true);
    assert.equal(rows.has(row(5, "external").Id), true);
    const mutations = calls.filter(args => args[1] === "rm");
    assert.equal(mutations.length, 2);
    assert.ok(mutations.every(args => args[2] === "--force" && args.length === 4));
    assert.ok(calls.every(args => !args.includes("--volumes") && !args.includes("prune")));
});
test("all-container removal includes created and external containers but excludes all Dockge variants", async (t) => {
    const own = row(1, "custom-daemon");
    own.Config.Hostname = "self-host";
    const marked = row(2, "custom-name", "running", { "io.dockge.protected": "true" });
    const legacy = row(3, "old-agent");
    legacy.Config.Image = "louislam/dockge:1";
    const renamed = row(4, "renamed-agent");
    renamed.Config.Cmd = [ "tsx", "./backend/index.ts" ];
    const { service, rows, calls } = engine(t, [ own, marked, legacy, renamed, row(5, "app"), row(6, "old", "exited"), row(7, "new", "created") ]);
    const preview = await service.preview(7, { scope: "all",
        remove: true });
    assert.equal(preview.count, 3);
    assert.equal(preview.protectedCount, 4);
    service.execute(7, preview.token);
    await finished(service, preview.token);
    assert.equal(rows.size, 4);
    assert.ok(calls.filter(args => args[1] === "rm").every(args => ![ own.Id, marked.Id, legacy.Id, renamed.Id ].includes(args.at(-1)!)));
});
test("kill-only uses kill, handles paused containers and leaves stopped containers intact", async (t) => {
    const { service, rows, calls } = engine(t);
    rows.set(row(6, "paused").Id, row(6, "paused", "paused"));
    const preview = await service.preview(7, { scope: "all",
        remove: false });
    assert.equal(preview.count, 3);
    service.execute(7, preview.token);
    const result = await finished(service, preview.token);
    assert.equal(result.results.filter(row => row.state === "killed").length, 3);
    assert.equal(calls.filter(args => args[1] === "rm").length, 0);
    assert.equal(calls.filter(args => args[1] === "unpause").length, 1);
    assert.equal(rows.size, 6);
});
test("bulk actions fail closed when self identification is uncertain and reject invalid options", async (t) => {
    const { service, calls } = engine(t, [ row(2, "app") ]);
    await assert.rejects(service.preview(7, { scope: "all",
        remove: true }), /safely identify/);
    await assert.rejects(service.preview(7, { scope: "anything",
        remove: true }), /Invalid bulk/);
    await assert.rejects(service.preview(7, { scope: "all",
        remove: "yes" }), /Invalid bulk/);
    assert.equal(calls.filter(args => [ "kill", "rm" ].includes(args[1])).length, 0);
});
test("execution rechecks protection and membership and only targets previewed IDs", async (t) => {
    const { service, rows, calls } = engine(t);
    const preview = await service.preview(7, { scope: "managed",
        remove: true });
    rows.get(row(2, "app").Id)!.Config.Labels = { "io.dockge.protected": "true" };
    rows.get(row(3, "old").Id)!.Config.Labels = { "com.docker.compose.project": "elsewhere" };
    rows.set(row(6, "new").Id, row(6, "new", "running", managedLabels));
    service.execute(7, preview.token);
    const result = await finished(service, preview.token);
    assert.equal(result.results.every(row => row.state === "skipped"), true);
    assert.equal(calls.filter(args => args[1] === "rm").length, 0);
    assert.equal(rows.has(row(6, "new").Id), true);
});
test("previews expire, belong to their user, and parallel bulk operations are locked", async (t) => {
    const { service, server } = engine(t);
    const first = await service.preview(7, { scope: "all",
        remove: true });
    assert.throws(() => service.execute(8, first.token), /not found/);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 300001);
    assert.throws(() => service.execute(7, first.token), /expired/);
    const second = await service.preview(7, { scope: "all",
        remove: false });
    const unlock = lockContainerOperations(server, null);
    assert.throws(() => service.execute(7, second.token), /already running/);
    await assert.rejects(Terminal.exec(server, undefined, "test", "docker", [ "compose", "up", "-d" ], "/opt/stacks/robot"), /bulk container operation/);
    unlock();
});
test("bulk jobs report individual failures and continue on other targets", async (t) => {
    const { service, failures } = engine(t);
    failures.add(row(2, "app").Id);
    const preview = await service.preview(7, { scope: "all",
        remove: true });
    service.execute(7, preview.token);
    const result = await finished(service, preview.token);
    assert.equal(result.state, "failed");
    assert.equal(result.completed, 4);
    assert.equal(result.results.filter(row => row.state === "failed").length, 1);
    assert.equal(result.results.filter(row => row.state === "removed").length, 3);
});
test("managed matching supports custom project names and config paths, and protection is metadata-based", () => {
    const container = row(9, "app", "running", { "com.docker.compose.project": "custom",
        "com.docker.compose.project.config_files": "/opt/stacks/robot/compose.yaml,/elsewhere/compose.yaml" });
    assert.equal(isManagedContainer(container, new Set([ "/opt/stacks/robot" ])), true);
    assert.equal(isManagedContainer(container, new Set([ "/opt/stacks/other" ])), false);
    container.Config.Image = "registry.example/renamed:latest";
    container.Config.Labels = { "io.dockge.protected": "true" };
    assert.equal(isDockgeContainer(container, "other"), true);
});
test("bulk RPC requires authentication and never accepts arbitrary Docker commands", async (t) => {
    const { service, server } = engine(t);
    Object.assign(server, { bulkContainers: service });
    const socket = { userID: 0 } as DockgeSocket;
    const events = new AgentSocket();
    new BulkContainerSocketHandler().create(socket, server, events);
    const invoke = async (input) => {
        let reply;
        await events.eventList.get("bulkContainerAction")!(input, result => reply = result);
        return reply;
    };
    assert.equal((await invoke({ action: "preview",
        options: { scope: "all",
            remove: true } })).ok, false);
    socket.userID = 7;
    assert.equal((await invoke({ action: "shell",
        command: "anything" })).ok, false);
    assert.equal((await invoke({ action: "preview",
        options: { scope: "all",
            remove: true } })).ok, true);
});
function browser(t: TestContext) {
    const old = globalThis.localStorage;
    const saved = new Map<string, string>();
    globalThis.localStorage = { getItem: key => saved.get(key) || null,
        setItem: (key, value) => saved.set(key, value) } as Storage;
    const instance = { ...bulkView.data(),
        $root: { username: "user",
            agentList: { "": {},
                agent: {},
                old: {} },
            info: { containerManagement: true },
            containerCapabilities: { agent: true,
                old: false },
            socketIO: { connected: true },
            agentStatusList: { agent: "online",
                old: "online" },
            endpointDisplayFunction: endpoint => endpoint || "Current" } };
    for (const [ key, method ] of Object.entries(bulkView.methods)) {
        instance[key] = method.bind(instance);
    }
    for (const [ key, getter ] of Object.entries(bulkView.computed)) {
        Object.defineProperty(instance, key, { get: () => getter.call(instance) });
    }
    t.after(() => {
        instance.disposed = true;
        clearTimeout(instance.timer);
        globalThis.localStorage = old;
    });
    return { instance,
        saved };
}
test("bulk dialog defaults to managed kill-only with no devices selected and previews agents independently", async (t) => {
    const { instance } = browser(t);
    assert.equal(instance.scope, "managed");
    assert.equal(instance.remove, false);
    assert.equal(instance.selected.length, 0);
    instance.selectAll();
    assert.deepEqual(instance.selected, [ "", "agent" ]);
    let rejectAgent!: (error: Error) => void;
    instance.request = async (endpoint) => endpoint ? new Promise((_resolve, reject) => {
        rejectAgent = reject;
    }) : { preview: { token: "local",
        count: 2,
        expires: Date.now() + 1000 } };
    const pending = instance.refreshPreviews();
    await delay(0);
    assert.equal(instance.previews[""].count, 2);
    rejectAgent(new Error("Offline"));
    await pending;
    assert.equal(instance.errors.agent, "Offline");
    assert.equal(instance.canRun, true, "An unavailable agent must not block ready devices");
});
test("bulk job IDs are saved before execution and can be restored after refresh", async (t) => {
    const { instance, saved } = browser(t);
    instance.selected = [ "" ];
    instance.previews[""] = { token: "job",
        count: 1,
        expires: Date.now() + 10000 };
    instance.request = async (_endpoint, request) => {
        assert.equal(JSON.parse(saved.get(instance.storageKey)!)[""].id, "job");
        return { job: { id: "job",
            state: "completed",
            total: 1,
            completed: 1,
            results: [] } };
    };
    await instance.execute();
    assert.equal(instance.jobs[""].state, "completed");
    instance.jobs = {};
    bulkView.mounted.call(instance);
    assert.equal(instance.jobs[""].id, "job");
});
test("agent requests release listeners on disconnect and do not retry destructive operations", async () => {
    const socket = new EventEmitter();
    let calls = 0;
    const pending = agentRequest({ getSocket: () => socket,
        socketIO: { connected: true },
        agentStatusList: {},
        emitAgent() {
            calls++;
        } }, "", "bulkContainerAction", { action: "execute" });
    socket.emit("disconnect");
    await assert.rejects(pending, /Connection lost/);
    assert.equal(socket.listenerCount("disconnect"), 0);
    assert.equal(socket.listenerCount("agentStatus"), 0);
    assert.equal(calls, 1);
});

test("an offline selected agent is skipped while ready agents execute without waiting", async t => {
    const { instance } = browser(t);
    instance.selected = [ "", "agent" ];
    instance.previews[""] = { token: "local",
        count: 1,
        expires: Date.now() + 10000 };
    instance.errors.agent = "Selected device is offline";
    const calls = [];
    instance.request = async (endpoint, input) => {
        calls.push([ endpoint, input.action ]);
        return { job: { id: "local",
            state: "completed",
            total: 1,
            completed: 1,
            results: [] } };
    };
    await instance.execute();
    assert.deepEqual(calls, [[ "", "execute" ]]);
    assert.equal(instance.jobs[""].state, "completed");
    assert.equal(instance.errors.agent, "Selected device is offline");
});

test("execution refuses all mutations if Dockge identity disappears after preview", async t => {
    const { service, rows, calls, self } = engine(t);
    const preview = await service.preview(7, { scope: "all",
        remove: true });
    rows.delete(self.Id);
    service.execute(7, preview.token);
    const job = await finished(service, preview.token);
    assert.equal(job.state, "failed");
    assert.match(job.message!, /safely identify/);
    assert.equal(calls.filter(args => [ "kill", "rm" ].includes(args[1])).length, 0);
});

test("managed matching resolves relative config labels and rejects another configuration in the same directory", () => {
    const container = row(9, "app", "running", { ...managedLabels,
        "com.docker.compose.project.config_files": "compose.yaml" });
    const directories = new Set([ "/opt/stacks/robot" ]);
    assert.equal(isManagedContainer(container, directories), true);
    container.Config.Labels!["com.docker.compose.project.config_files"] = "unmanaged.yaml";
    assert.equal(isManagedContainer(container, directories), false);
});

test("bulk command guards distinguish Compose verbs from services and environment filenames", () => {
    assert.equal(composeCommand([ "compose", "--env-file", "up", "logs", "build" ]), "logs");
    assert.equal(composeCommand([ "compose", "--progress", "plain", "exec", "up", "bash" ]), "exec");
    assert.equal(composeCommand([ "compose", "--env-file=up", "--progress=plain", "build", "api" ]), "build");
    assert.equal(composeCommand([ "compose", "--env-file", "../global.env", "--env-file", "./.env", "--progress", "plain", "up", "-d" ]), "up");
});
