import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { createMemoryHistory, createRouter } from "vue-router";
import * as util from "../common/util-common";
import { AgentSocket } from "../common/agent-socket";
import * as editor from "../frontend/src/compose-editor.js";

/** Execute the actual component script with browser/transport dependencies stubbed. */
function component(file: string, modules = {}) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const descriptor = file.endsWith(".vue") ? parse(source).descriptor : null;
    const script = descriptor?.script?.content || source;
    const timers = new Map();
    let now = 0;
    let nextTimer = 0;
    const context = vm.createContext({
        exports: {},
        console,
        process: { env: {} },
        localStorage: {},
        window: { removeEventListener() {} },
        location: { protocol: "http:",
            host: "localhost" },
        require: name => modules[name] || (name.endsWith("util-common") ? util
            : name.endsWith("compose-editor") ? editor
                : name.endsWith("agent-socket") ? { AgentSocket }
                    : name === "vue" ? { defineComponent: options => options } : {}),
        setTimeout: (fn, delay) => {
            timers.set(++nextTimer, { fn,
                time: now + delay });
            return nextTimer;
        },
        clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
    const options = context.exports.default;
    const instance = Object.assign(options.data?.call({ $t: text => text }) || {}, {
        endpoint: "",
        $route: { path: "/compose/test",
            params: {} },
        $root: { completeStackList: {} },
        $refs: {},
        $nextTick: fn => fn(),
        $t: text => text,
    });
    for (const [ name, method ] of Object.entries(options.methods || {})) {
        instance[name] = method.bind(instance);
    }
    for (const [ name, getter ] of Object.entries(options.computed || {})) {
        Object.defineProperty(instance, name, {
            get: () => (typeof getter === "function" ? getter : getter.get).call(instance),
            configurable: true,
        });
    }
    return {
        instance,
        options,
        template: descriptor?.template?.content || "",
        tick(ms) {
            now += ms;
            for (const [ id, timer ] of timers) {
                if (timer.time <= now) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        },
    };
}

test("Stop remains enabled during Start and late Start replies cannot unlock a pending Stop", () => {
    const { instance: page, template } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    const calls = [];
    page.$root.emitAgent = (...args) => calls.push(args);
    page.$root.toastRes = () => {};
    page.requestServiceStatus = () => {};
    page.startStack();
    assert.equal(page.processing, true);
    assert.equal(page.stopping, false);
    assert.equal(page.showProgressTerminal, true, "Show progress even before the first terminal byte");
    const stopButton = template.match(/<button[^>]*@click="stopStack"[^>]*>/)[0];
    const visible = stopButton.match(/v-if="([^"]+)"/)[1];
    const disabled = stopButton.match(/:disabled="([^"]+)"/)[1];
    assert.equal(vm.runInNewContext(visible, page), true);
    assert.equal(vm.runInNewContext(disabled, page), false);
    // Deploy must also be interruptible while its editor is still visible.
    page.isEditMode = true;
    assert.equal(vm.runInNewContext(visible, page), true);
    page.stopStack();
    assert.deepEqual(calls.map(call => call[1]), [ "startStack", "stopStack" ]);
    assert.equal(page.stopping, true);
    calls[0].at(-1)({ ok: false,
        msg: "cancelled" });
    assert.equal(page.processing, true);
    assert.equal(page.stopping, true);
    page.stopStack();
    assert.equal(calls.length, 2, "Do not send duplicate Stop requests");
    calls[1].at(-1)({ ok: true });
    assert.equal(page.processing, false);
    assert.equal(page.stopping, false);
});

test("a service Start stays enabled while bulk startup waits and only locks its own service", () => {
    const { instance: page } = component("../frontend/src/pages/Compose.vue");
    const { instance: card, template } = component("../frontend/src/components/Container.vue");
    page.stack = { name: "test" };
    page.jsonConfig.services = { first: {},
        second: {} };
    page.processing = false;
    card.$parent = { $parent: page };
    card.name = "first";
    card.isEditMode = false;
    card.serviceStatus = [{ state: "created",
        status: "created" }];
    const calls = [];
    page.$root.emitAgent = (...args) => calls.push(args);
    page.$root.toastRes = () => {};
    page.requestServiceStatus = () => {};
    page.startStack();
    const bulkRequest = page.operationRequest;
    const button = template.match(/<button\b(?:[^">]|"[^"]*")*@click="startService"(?:[^">]|"[^"]*")*>/)[0];
    const visible = button.match(/v-if="([^"]+)"/)[1];
    const disabled = button.match(/:disabled="([^"]+)"/)[1];
    assert.equal(page.processing, true);
    assert.equal(vm.runInNewContext(visible, card), true);
    assert.equal(vm.runInNewContext(disabled, card), false, "A waiting bulk Up must not disable the service button");
    page.startService("first");
    assert.equal(card.processing, true);
    card.name = "second";
    assert.equal(card.processing, false, "Other services must remain controllable");
    assert.equal(page.operationRequest, bulkRequest, "A service action must not supersede the bulk action");
    page.startService("first");
    assert.equal(calls.length, 2, "Duplicate clicks on one service must be ignored");
    calls[1].at(-1)({ ok: true });
    assert.equal(page.processing, true, "The bulk request is still pending");
    card.name = "first";
    assert.equal(card.processing, false);
    calls[0].at(-1)({ ok: true });
    assert.equal(page.stackBusy, false);
});

test("a single-service card has Start when stopped and Stop/Restart when running", () => {
    const { instance: page } = component("../frontend/src/pages/Compose.vue");
    const { instance: card, template } = component("../frontend/src/components/Container.vue");
    page.jsonConfig.services = { only: {} };
    page.processing = false;
    card.$parent = { $parent: page };
    card.name = "only";
    card.isEditMode = false;
    const visible = event => {
        const button = template.match(new RegExp(`<button\\b(?:[^">]|"[^"]*")*@click="${event}"(?:[^">]|"[^"]*")*>`))[0];
        return vm.runInNewContext(button.match(/v-if="([^"]+)"/)[1], card);
    };
    card.serviceStatus = [{ state: "created",
        status: "created" }];
    assert.equal(visible("startService"), true);
    assert.equal(visible("stopService"), false);
    assert.equal(visible("restartService"), false);
    assert.equal(card.processing, false);
    card.serviceStatus = [{ state: "running",
        status: "healthy" }];
    assert.equal(visible("startService"), false);
    assert.equal(visible("stopService"), true);
    assert.equal(visible("restartService"), true);
    card.isEditMode = true;
    assert.equal(visible("startService"), false);
    assert.equal(visible("stopService"), false);
    assert.equal(visible("restartService"), false);
});

test("Stop supersedes service operations without letting their late replies unlock shutdown", () => {
    const { instance: page } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    page.processing = false;
    const calls = [];
    page.$root.emitAgent = (...args) => calls.push(args);
    page.$root.toastRes = () => {};
    page.requestServiceStatus = () => {};
    page.startStack();
    page.startService("first");
    page.startService("second");
    page.stopStack();
    calls[0].at(-1)({ ok: false,
        msg: "cancelled" });
    calls[1].at(-1)({ ok: false,
        msg: "cancelled" });
    calls[2].at(-1)({ ok: false,
        msg: "cancelled" });
    assert.equal(page.stopping, true);
    assert.equal(page.processing, true);
    assert.equal(Object.keys(page.serviceOperations).length, 0);
    page.startService("third");
    assert.equal(calls.length, 4, "New service actions must wait until shutdown finishes");
    calls[3].at(-1)({ ok: true });
    assert.equal(page.stopping, false);
    assert.equal(page.stackBusy, false);
});

test("a partially running stack can retry Up instead of being limited to Restart", () => {
    const { instance: page, template } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    page.processing = false;
    page.$root.completeStackList.test_ = { status: util.RUNNING };
    page.serviceStatusList = {
        ready: [{ state: "running" }],
        waiting: [{ state: "created" }],
    };
    const button = template.match(/<button[^>]*@click="startStack"[^>]*>/)[0];
    const visible = button.match(/v-if="([^"]+)"/)[1];
    assert.equal(vm.runInNewContext(visible, page), true);
    page.serviceStatusList.waiting = [{ state: "running" }];
    assert.equal(vm.runInNewContext(visible, page), false);
});

test("service polling updates the stack badge and controls without waiting for the global poll", () => {
    const { instance: page } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    page.$root.completeStackList.test_ = { status: util.CREATED_FILE };
    let reply;
    page.$root.emitAgent = (...args) => {
        reply = args.at(-1);
    };
    page.requestServiceStatus();
    reply({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: { included: [{ state: "running",
            status: "starting" }] } });
    assert.equal(page.active, true);
    assert.equal(page.$root.completeStackList.test_.status, util.RUNNING);
    reply({ ok: false,
        msg: "Temporary polling failure" });
    assert.equal(page.active, true);
    reply({ ok: true,
        stackStatus: util.CREATED_FILE,
        serviceStatusList: {} });
    assert.equal(page.active, false);
});

test("running services with starting/unhealthy checks and mixed replicas get running controls", () => {
    const { instance: container } = component("../frontend/src/components/Container.vue");
    for (const status of [ "starting", "unhealthy", "healthy", "running" ]) {
        container.serviceStatus = [{ state: "running",
            status,
            health: status === "running" ? "" : status }];
        assert.equal(container.isRunning, true);
        assert.equal(container.status, "running");
        assert.equal(container.health, status === "running" ? "" : status);
        // Older agents expose only status, so preserve their compatibility.
        container.serviceStatus = [{ status }];
        assert.equal(container.isRunning, true);
    }
    container.serviceStatus = [{ state: "exited",
        status: "exited" }, { state: "running",
        status: "starting" }];
    assert.equal(container.isRunning, true);
    assert.equal(container.status, "running");
    container.serviceStatus = [{ state: "exited",
        status: "healthy" }];
    assert.equal(container.isRunning, false, "Container state takes precedence over a stale health result");
    container.serviceStatus = [];
    assert.equal(container.isRunning, false);
    assert.equal(container.status, "N/A");
});

test("a lost status reply is retried and a late reply cannot overwrite the fresh state", () => {
    const { instance: page, tick } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    page.$root.completeStackList.test_ = { status: util.CREATED_STACK };
    const replies = [];
    page.$root.emitAgent = (...args) => replies.push(args.at(-1));
    page.requestServiceStatus();
    tick(14999);
    assert.equal(replies.length, 1, "Do not overlap ordinary slow polls");
    tick(1);
    assert.equal(replies.length, 2, "Retry without needing the missing acknowledgement");
    assert.match(page.serviceStatusError, /timed out/);
    replies[1]({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: { app: [{ state: "running",
            status: "healthy" }] } });
    assert.equal(page.active, true);
    assert.equal(page.serviceStatusError, "");
    replies[0]({ ok: true,
        stackStatus: util.CREATED_STACK,
        serviceStatusList: { app: [{ state: "created",
            status: "created" }] } });
    assert.equal(page.active, true);
    assert.equal(page.serviceStatusList.app[0].state, "running");
    tick(5000);
    assert.equal(replies.length, 3, "Successful replies resume normal polling");
});

test("every card in a multi-service startup converges to the latest running snapshot", () => {
    const { instance: page, tick } = component("../frontend/src/pages/Compose.vue");
    const { instance: card } = component("../frontend/src/components/Container.vue");
    page.stack = { name: "test" };
    const replies = [];
    page.$root.emitAgent = (...args) => replies.push(args.at(-1));
    const initial = {
        waiting: [{ state: "created",
            status: "created",
            health: "" }],
        checking: [{ state: "running",
            status: "starting",
            health: "starting" }],
        ready: [{ state: "running",
            status: "healthy",
            health: "healthy" }],
    };
    const running = Object.fromEntries(Object.keys(initial).map(name => [ name, [{ state: "running",
        status: "healthy",
        health: "healthy" }]]));
    page.requestServiceStatus();
    replies[0]({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: initial });
    tick(5000);
    // The next acknowledgement is lost while the other containers start.
    tick(15000);
    replies[2]({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: running });
    replies[1]({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: initial });
    for (const name of Object.keys(initial)) {
        card.serviceStatus = page.serviceStatusList[name];
        assert.equal(card.status, "running", `${name} must show the latest state`);
        assert.equal(card.health, "healthy");
        assert.equal(card.isRunning, true);
    }
});

test("an action refresh supersedes an earlier poll and errors keep retrying visibly", () => {
    const { instance: page, tick } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    const replies = [];
    page.$root.emitAgent = (...args) => replies.push(args.at(-1));
    page.requestServiceStatus();
    page.requestServiceStatus();
    replies[1]({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: { app: [{ state: "running",
            status: "healthy" }] } });
    replies[0]({ ok: true,
        stackStatus: util.CREATED_STACK,
        serviceStatusList: { app: [{ state: "created",
            status: "created" }] } });
    assert.equal(page.serviceStatusList.app[0].state, "running");
    tick(5000);
    replies[2]({ ok: false,
        msg: "Docker unavailable" });
    assert.equal(page.serviceStatusError, "Docker unavailable");
    assert.equal(page.serviceStatusList.app[0].state, "running");
    tick(5000);
    assert.equal(replies.length, 4);
});

test("leaving a page stops retries and ignores outstanding status replies", () => {
    const { instance: page, tick } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    const calls = [];
    page.$root.emitAgent = (...args) => calls.push(args);
    page.requestServiceStatus();
    page.exitAction();
    calls[0].at(-1)({ ok: true,
        stackStatus: util.RUNNING,
        serviceStatusList: { app: [{ state: "running",
            status: "healthy" }] } });
    assert.equal(Object.keys(page.serviceStatusList).length, 0);
    tick(20000);
    assert.equal(calls.filter(call => call[1] === "serviceStatusList").length, 1);
});

test("initial configuration loads immediately while typing waits for three idle seconds", () => {
    const page = component("../frontend/src/pages/Compose.vue");
    page.instance.stack = { name: "test" };
    const calls = [];
    page.instance.$root.emitAgent = (...args) => calls.push(args);
    page.instance.scheduleConfigResolution();
    page.tick(0);
    assert.equal(calls.length, 1);
    page.instance.isEditMode = true;
    page.instance.scheduleConfigResolution();
    page.tick(2000);
    page.instance.scheduleConfigResolution();
    page.tick(2999);
    assert.equal(calls.length, 1);
    calls[0].at(-1)({ ok: false,
        msg: "obsolete response" });
    assert.equal(page.instance.configError, "");
    page.tick(1);
    assert.equal(calls.length, 2);
});

test("terminal output arriving before the join acknowledgement is displayed", () => {
    const handlers = new Map();
    const socket = { on: (event, callback) => handlers.set(event, callback) };
    const { instance: root } = component("../frontend/src/mixins/socket.ts", { "socket.io-client": { io: () => socket } });
    root.initSocketIO();
    const output = [];
    let acknowledge;
    root.emitAgent = (...args) => {
        acknowledge = args.at(-1);
    };
    root.toastRes = () => {};
    root.bindTerminal("", "compose-test", { write: data => output.push(data) });
    handlers.get("agent")("terminalWrite", "compose-test", "Starting\r\n");
    assert.deepEqual(output, [ "Starting\r\n" ]);
    acknowledge({ ok: true,
        buffer: "" });
    handlers.get("agent")("terminalWrite", "compose-test", "Started\r\n");
    assert.deepEqual(output, [ "Starting\r\n", "", "Started\r\n" ]);
});

test("container log links navigate like Bash and action grids have four or two buttons", () => {
    const { instance: card, template } = component("../frontend/src/components/Container.vue");
    const page = { endpoint: "",
        stack: { name: "demo" } };
    card.$parent = { $parent: page };
    card.name = "included";
    card.isEditMode = false;
    assert.equal(card.logsRouteLink.name, "containerLogs");
    assert.deepEqual({ ...card.logsRouteLink.params }, { stackName: "demo",
        serviceName: "included" });
    page.endpoint = "agent.example:5001";
    assert.equal(card.logsRouteLink.name, "containerLogsEndpoint");
    assert.equal(card.logsRouteLink.params.endpoint, page.endpoint);
    const actions = template.match(/<div class="service-actions"[\s\S]*?<\/div>/)[0];
    const tags = actions.match(/<(?:button|router-link)\b(?:[^">]|"[^"]*")*>/g);
    const visible = () => tags.filter(tag => vm.runInNewContext(tag.match(/v-if="([^"]+)"/)[1], card));
    card.serviceStatus = [{ state: "running" }];
    assert.equal(visible().length, 4);
    assert.match(visible()[0], /terminalRouteLink/);
    assert.match(visible()[1], /logsRouteLink/);
    assert.doesNotMatch(visible()[1], /target=/);
    card.serviceStatus = [{ state: "exited" }];
    assert.equal(visible().length, 2);
    assert.match(visible()[0], /startService/);
    assert.match(visible()[1], /logsRouteLink/);
    card.isEditMode = true;
    assert.equal(visible().length, 0);
});

test("the standalone log routes bypass the dashboard and use their own read-only stream", () => {
    const { instance: page, template } = component("../frontend/src/pages/ContainerLogs.vue");
    page.$route.params = { stackName: "demo",
        serviceName: "included",
        endpoint: "agent.example:5001" };
    assert.equal(page.terminalName, util.getContainerLogsTerminalName("agent.example:5001", "demo", "included"));
    assert.notEqual(page.terminalName, util.getCombinedTerminalName(page.endpoint, page.stackName));
    assert.match(template, /mode="containerLogs"/);
    const context = vm.createContext({
        exports: {},
        require: name => name === "vue-router" ? { createRouter,
            createWebHistory: createMemoryHistory } : { default: {} },
    });
    const source = readFileSync(new URL("../frontend/src/router.ts", import.meta.url), "utf8");
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
    const router = context.exports.router;
    for (const endpoint of [ "", "agent.example:5001" ]) {
        const route = router.resolve({ name: endpoint ? "containerLogsEndpoint" : "containerLogs",
            params: { stackName: "demo",
                serviceName: "included",
                ...(endpoint ? { endpoint } : {}) } });
        assert.equal(route.matched.length, 2, "Only the login layout and log page must be mounted");
        assert.equal(route.meta.fullscreenLogs, true);
        assert.equal(route.params.serviceName, "included");
        assert.equal(route.params.endpoint || "", endpoint);
    }
});

test("log subscriptions use the selected service, reconnect after login, and leave without touching combined logs", () => {
    const { instance: terminal, options } = component("../frontend/src/components/Terminal.vue");
    const calls = [];
    let resets = 0;
    let disposed = false;
    terminal.$root.socketIO = { connected: true,
        authenticatedConnectCount: 1 };
    terminal.$root.agentStatusList = { "agent.example": "offline" };
    terminal.$root.bindTerminal = (...args) => calls.push([ "bind", ...args ]);
    terminal.$root.unbindTerminal = (...args) => calls.push([ "unbind", ...args ]);
    terminal.$root.emitAgent = (...args) => calls.push([ "emit", ...args ]);
    terminal.endpoint = "agent.example";
    terminal.name = "selected-log-stream";
    terminal.stackName = "demo";
    terminal.serviceName = "included";
    terminal.mode = "containerLogs";
    terminal.terminal = { reset: () => resets++,
        dispose: () => disposed = true };
    terminal.bind();
    assert.deepEqual(calls[0].slice(0, 3), [ "bind", terminal.endpoint, terminal.name ]);
    assert.equal(calls[0][4], "containerLogs");
    assert.deepEqual(Array.from(calls[0][5]), [ "demo", "included" ]);
    options.watch.logConnection.call(terminal);
    assert.equal(resets, 0, "Wait until the remote agent is online");
    terminal.$root.agentStatusList[terminal.endpoint] = "online";
    options.watch.logConnection.call(terminal);
    assert.equal(resets, 1);
    terminal.mode = "displayOnly";
    options.watch.logConnection.call(terminal);
    assert.equal(resets, 1, "Existing terminals must not change on reconnect");
    terminal.mode = "containerLogs";
    terminal.$refs.terminal = { removeEventListener() {} };
    options.unmounted.call(terminal);
    assert.equal(disposed, true);
    const leave = calls.find(call => call[0] === "emit");
    assert.deepEqual(leave.slice(1, 5), [ "agent.example", "leaveContainerLogs", "demo", "included" ]);
    assert.deepEqual(calls.at(-1), [ "unbind", "selected-log-stream" ]);
});

test("log history is replayed once and stale reconnect replies are ignored", () => {
    const handlers = new Map();
    const socket = { on: (event, callback) => handlers.set(event, callback) };
    const modules = { "socket.io-client": { io: () => socket } };
    const { instance: root } = component("../frontend/src/mixins/socket.ts", modules);
    root.initSocketIO();
    root.afterLogin();
    assert.equal(root.socketIO.authenticatedConnectCount, 1);
    const calls = [];
    const output = [];
    root.emitAgent = (...args) => calls.push(args);
    root.toastRes = () => {};
    const terminal = { write: data => output.push(data) };
    root.bindTerminal("", "service-logs", terminal, "containerLogs", [ "demo", "included" ]);
    assert.deepEqual(calls[0].slice(0, 4), [ "", "containerLogs", "demo", "included" ]);
    root.bindTerminal("", "service-logs", terminal, "containerLogs", [ "demo", "included" ]);
    calls[0].at(-1)({ ok: true,
        buffer: "stale history" });
    calls[1].at(-1)({ ok: true,
        buffer: "history\r\n" });
    handlers.get("agent")("terminalWrite", "service-logs", "live\r\n");
    assert.deepEqual(output, [ "history\r\n", "live\r\n" ]);
    root.unbindTerminal("service-logs");
    handlers.get("agent")("terminalWrite", "service-logs", "after leaving");
    assert.equal(output.length, 2);
});
