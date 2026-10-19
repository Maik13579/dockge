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
import { searchTerminal } from "../frontend/src/terminal-search.js";
import * as containerStatus from "../frontend/src/container-status.js";

/** Execute the actual component script with browser/transport dependencies stubbed. */
function component(file: string, modules = {}, storage = {}, browser = {}) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const descriptor = file.endsWith(".vue") ? parse(source).descriptor : null;
    const script = descriptor?.script?.content || source;
    const timers = new Map();
    let now = 0;
    let nextTimer = 0;
    const browserWindow = { innerWidth: 1280,
        addEventListener() {},
        removeEventListener() {},
        ...browser };
    const context = vm.createContext({
        exports: {},
        console,
        process: { env: {} },
        localStorage: storage,
        window: browserWindow,
        ResizeObserver: browser.ResizeObserver,
        location: { protocol: "http:",
            host: "localhost" },
        require: name => modules[name] || (name.endsWith("util-common") ? util
            : name.endsWith("compose-editor") ? editor
                : name.endsWith("terminal-search") ? { searchTerminal }
                    : name.endsWith("container-status") ? containerStatus
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
        browser: browserWindow,
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

test("the edit-only Compose setting hides both file views and expands containers, but always shows editors when editing", () => {
    const { instance: page, template } = component("../frontend/src/pages/Compose.vue");
    page.$root.info = {};
    page.isEditMode = false;
    page.stack = { composeYAML: "include: [shared.yaml]",
        composeOverrideYAML: "services: {}" };
    const original = JSON.stringify(page.stack);
    const width = template.match(/<div :class="([^"]*showComposeFiles[^"]*)"/)[1];
    assert.match(template, /<div v-if="showComposeFiles" class="col-lg-6">/);
    assert.equal(page.showComposeFiles, true, "Existing behavior is the default");
    assert.equal(vm.runInNewContext(width, page), "col-lg-6");
    page.$root.info.showComposeOnlyInEditMode = true;
    assert.equal(page.showComposeFiles, false);
    assert.equal(vm.runInNewContext(width, page), "col-12");
    page.isEditMode = true;
    assert.equal(page.showComposeFiles, true);
    assert.equal(vm.runInNewContext(width, page), "col-lg-6");
    page.$route.path = "/compose";
    assert.equal(page.isAdd, true);
    assert.equal(page.showComposeFiles, true, "New stacks must retain their editors");
    page.isEditMode = false;
    page.$root.info.showComposeOnlyInEditMode = false;
    assert.equal(page.showComposeFiles, true);
    assert.equal(JSON.stringify(page.stack), original, "Changing layout must not change either file");
});

test("general view settings preserve edit-only files and friendly-name preferences when saved", () => {
    const { instance: page } = component("../frontend/src/pages/Settings.vue");
    let stored = {};
    page.$root.toastRes = () => {};
    page.$root.getSocket = () => ({ emit(event, ...args) {
        const callback = args.at(-1);
        if (event === "getSettings") {
            callback({ data: { ...stored } });
        } else if (event === "setSettings") {
            stored = { ...args[0] };
            callback({ ok: true });
        }
    } });
    page.loadSettings();
    assert.equal(page.settings.showComposeOnlyInEditMode, false);
    assert.equal(page.settings.showAgentFriendlyNames, true);
    assert.equal(page.settingsLoaded, true);
    page.settings.showComposeOnlyInEditMode = true;
    page.settings.showAgentFriendlyNames = false;
    page.saveSettings();
    assert.equal(stored.showComposeOnlyInEditMode, true);
    assert.equal(page.settings.showComposeOnlyInEditMode, true);
    assert.equal(stored.showAgentFriendlyNames, false);
    assert.equal(page.settings.showAgentFriendlyNames, false);
    page.settings.showComposeOnlyInEditMode = false;
    page.settings.showAgentFriendlyNames = true;
    page.saveSettings();
    assert.equal(stored.showComposeOnlyInEditMode, false);
    assert.equal(stored.showAgentFriendlyNames, true);
});

test("sidebar visibility and width persist while small windows clamp the display without losing preferences", () => {
    const modules = {};
    const storage = { stackSidebarWidth: "450",
        stackSidebarCollapsed: "true" };
    const { instance: page, options, browser } = component("../frontend/src/pages/Dashboard.vue", modules, storage);
    let width = 1200;
    const focused = [];
    page.$refs = {
        container: { offsetHeight: 500 },
        dashboard: { getBoundingClientRect: () => ({ width }) },
        hideSidebar: { focus: () => focused.push("hide") },
        showSidebar: { focus: () => focused.push("show") },
    };
    options.mounted.call(page);
    assert.equal(page.sidebarVisible, false);
    page.toggleSidebar();
    assert.equal(page.sidebarVisible, true);
    assert.equal(page.sidebarDisplayWidth, 450);
    assert.equal(storage.stackSidebarCollapsed, "false");
    page.toggleSidebar();
    assert.equal(page.sidebarVisible, false);
    assert.deepEqual(focused, [ "hide", "show" ]);
    page.toggleSidebar();
    browser.innerWidth = 800;
    width = 780;
    page.measureLayout();
    assert.equal(page.sidebarDisplayWidth, 390);
    assert.equal(storage.stackSidebarWidth, "450");
    browser.innerWidth = 500;
    page.measureLayout();
    assert.equal(page.sidebarAvailable, false);
    assert.equal(page.sidebarCollapsed, false);
    browser.innerWidth = 1280;
    width = 1200;
    page.measureLayout();
    assert.equal(page.sidebarVisible, true);
    assert.equal(page.sidebarDisplayWidth, 450);
    const reloaded = component("../frontend/src/pages/Dashboard.vue", modules, storage).instance;
    assert.equal(reloaded.sidebarWidth, 450);
    assert.equal(reloaded.sidebarCollapsed, false);
    for (const value of [ "invalid", "Infinity", "-1" ]) {
        const invalidStorage = { stackSidebarWidth: value };
        const invalid = component("../frontend/src/pages/Dashboard.vue", modules, invalidStorage).instance;
        assert.equal(invalid.sidebarWidth, 280);
    }
});

test("sidebar dragging respects limits and pointer ownership, and cleans up on release or leaving", () => {
    const listeners = new Map();
    const storage = {};
    const modules = {};
    const browser = {
        addEventListener: (event, callback) => listeners.set(event, callback),
        removeEventListener: event => listeners.delete(event),
    };
    const { instance: page, options } = component("../frontend/src/pages/Dashboard.vue", modules, storage, browser);
    let captured;
    const handle = { setPointerCapture: id => captured = id,
        hasPointerCapture: id => captured === id,
        releasePointerCapture: () => captured = undefined };
    const event = { button: 0,
        clientX: 300,
        pointerId: 7,
        currentTarget: handle,
        preventDefault() {} };
    page.startSidebarResize({ ...event,
        button: 2 });
    assert.equal(page.resizingSidebar, false);
    page.startSidebarResize(event);
    assert.equal(captured, 7);
    assert.equal(listeners.size, 4);
    page.resizeSidebar({ pointerId: 8,
        clientX: 1000 });
    assert.equal(page.sidebarWidth, 280);
    page.resizeSidebar({ pointerId: 7,
        clientX: 1000 });
    assert.equal(page.sidebarWidth, 600);
    page.resizeSidebar({ pointerId: 7,
        clientX: -1000 });
    assert.equal(page.sidebarWidth, 180);
    page.resizeSidebar({ pointerId: 7,
        clientX: 420 });
    assert.equal(page.sidebarWidth, 400);
    page.stopSidebarResize({ pointerId: 8 });
    assert.equal(page.resizingSidebar, true);
    listeners.get("pointerup")({ pointerId: 7 });
    assert.equal(page.resizingSidebar, false);
    assert.equal(captured, undefined);
    assert.equal(listeners.size, 0);
    assert.equal(storage.stackSidebarWidth, "400");
    page.startSidebarResize(event);
    options.beforeUnmount.call(page);
    assert.equal(listeners.size, 0);
    assert.equal(captured, undefined);
    let prevented = 0;
    page.resizeSidebarWithKeyboard({ key: "Home",
        preventDefault: () => prevented++ });
    assert.equal(storage.stackSidebarWidth, "180");
    page.resizeSidebarWithKeyboard({ key: "ArrowRight",
        preventDefault: () => prevented++ });
    assert.equal(page.sidebarWidth, 196);
    page.resizeSidebarWithKeyboard({ key: "End",
        preventDefault: () => prevented++ });
    assert.equal(page.sidebarWidth, 600);
    assert.equal(prevented, 3);
});

test("terminals refit after sidebar container resizing and disconnect their observer when closed", () => {
    let resize;
    let observed;
    let disconnected = false;
    let fits = 0;
    class Observer {
        constructor(callback) {
            resize = callback;
        }

        observe(element) {
            observed = element;
        }

        disconnect() {
            disconnected = true;
        }
    }
    class Fit {
        fit() {
            fits++;
        }
    }
    const modules = { "@xterm/addon-fit": { FitAddon: Fit } };
    const storage = {};
    const browser = { ResizeObserver: Observer };
    const { instance: terminal, options } = component("../frontend/src/components/Terminal.vue", modules, storage, browser);
    const events = [];
    terminal.mode = "displayOnly";
    terminal.name = "compose-demo";
    terminal.terminal = { rows: 20,
        cols: 100,
        loadAddon() {},
        dispose() {} };
    terminal.$el = { clientWidth: 700,
        clientHeight: 300 };
    terminal.$root.emitAgent = (...args) => events.push(args);
    terminal.$root.unbindTerminal = () => {};
    terminal.updateTerminalSize();
    assert.equal(observed, terminal.$el);
    assert.equal(fits, 1);
    terminal.$el.clientWidth = 0;
    resize();
    assert.equal(fits, 1, "Hidden progress terminals must not be fitted");
    terminal.$el.clientWidth = 900;
    resize();
    assert.equal(fits, 2);
    assert.deepEqual(events[0], [ "", "terminalResize", "compose-demo", 20, 100 ]);
    options.unmounted.call(terminal);
    assert.equal(disconnected, true);
});

test("agent labels use friendly names by default, fall back to endpoints and honor the address preference", () => {
    const { instance: root } = component("../frontend/src/mixins/socket.ts");
    root.agentList = {
        "10.0.0.1:5001": { name: " Jetson " },
        "10.0.0.2:5001": { name: "" },
        "10.0.0.3:5001": { name: "   " },
    };
    assert.equal(root.endpointDisplayFunction("10.0.0.1:5001"), "Jetson");
    assert.equal(root.endpointDisplayFunction("10.0.0.2:5001"), "10.0.0.2:5001");
    assert.equal(root.endpointDisplayFunction("10.0.0.3:5001"), "10.0.0.3:5001");
    assert.equal(root.endpointDisplayFunction("not-yet-loaded:5001"), "not-yet-loaded:5001");
    assert.equal(root.endpointDisplayFunction("current"), root.$t("currentEndpoint"));
    assert.equal(root.endpointDisplayFunction(""), root.$t("currentEndpoint"));
    root.info.showAgentFriendlyNames = false;
    assert.equal(root.endpointDisplayFunction("10.0.0.1:5001"), "10.0.0.1:5001");
    root.info.showAgentFriendlyNames = true;
    assert.equal(root.endpointDisplayFunction("10.0.0.1:5001"), "Jetson");
});

test("the log header returns to the correct stack and delegates search directions and clearing", () => {
    const { instance: page, template } = component("../frontend/src/pages/ContainerLogs.vue");
    page.$route.params = { stackName: "demo",
        serviceName: "included" };
    assert.equal(page.stackRoute, "/compose/demo");
    page.$route.params.endpoint = "agent.example:5001";
    assert.equal(page.stackRoute, "/compose/demo/agent.example%3A5001");
    assert.match(template, /<router-link :to="stackRoute"/);
    assert.match(template, /@keydown.enter.prevent="searchLogs\(\$event.shiftKey\)"/);
    assert.match(template, /@keydown.esc.prevent="clearSearch"/);
    const searches = [];
    page.$refs.logs = { findText: (...args) => {
        searches.push(args);
        return args[0] === "error";
    } };
    page.searchQuery = "error";
    page.searchLogs(false, true);
    assert.equal(page.searchFound, true);
    page.searchLogs(true);
    assert.equal(searches[1][1].backwards, true);
    assert.equal(searches[1][1].restart, false);
    page.searchQuery = "missing";
    page.searchLogs();
    assert.equal(page.searchFound, false);
    page.clearSearch();
    assert.equal(page.searchQuery, "");
    assert.equal(searches.at(-1)[0], "");
    assert.equal(searches.at(-1)[1].restart, true);
});

test("programmatic search highlights do not overwrite the clipboard, while manual selection still copies", () => {
    const { instance: terminal } = component("../frontend/src/components/Terminal.vue");
    const copied = [];
    terminal.copyToClipboard = text => copied.push(text);
    const cell = { getWidth: () => 1,
        getChars: () => "x" };
    terminal.terminal = {
        cols: 1,
        rows: 1,
        buffer: { active: { length: 1,
            getNullCell: () => cell,
            getLine: row => row === 0 ? { length: 1,
                getCell: () => cell,
                translateToString: () => "x" } : undefined } },
        getSelectionPosition: () => undefined,
        getSelection: () => "x",
        select: () => terminal.handleSelection(),
        scrollToLine: () => {},
        clearSelection: () => {},
    };
    assert.equal(terminal.findText("x"), true);
    assert.equal(terminal.searchSelecting, false);
    assert.deepEqual(copied, []);
    terminal.handleSelection();
    assert.deepEqual(copied, [ "x" ]);
});

test("compact view is opt-in and remembers the browser preference across stack pages", () => {
    const storage = {};
    const { instance: page, template } = component("../frontend/src/pages/Compose.vue", {}, storage);
    assert.equal(page.compactView, false);
    page.setContainerView(true);
    assert.equal(storage.containerView, "compact");
    const next = component("../frontend/src/pages/Compose.vue", {}, storage).instance;
    assert.equal(next.compactView, true);
    next.setContainerView(false);
    assert.equal(storage.containerView, "cards");
    assert.match(template, /:compact="compactView"/);
    assert.match(template, /v-if="!isEditMode"[^>]*:aria-label="\$t\('Container view'\)"/);
});

test("compact rows show only Start or Stop, and expansion restores the original controls and metrics", () => {
    const { instance: card, template } = component("../frontend/src/components/Container.vue");
    card.compact = true;
    card.isEditMode = false;
    card.serviceStatus = [{ state: "running",
        name: "api-1" }];
    card.dockerStats = { "api-1": { CPUPerc: "2.5%",
        MemUsage: "100MiB / 8GiB" } };
    const actions = template.match(/<div class="service-actions"[\s\S]*?<\/div>/)[0];
    const tags = actions.match(/<(?:button|router-link)\b(?:[^">]|"[^"]*")*>/g);
    const visible = () => tags.filter(tag => vm.runInNewContext(tag.match(/v-if="([^"]+)"/)[1], card));
    assert.equal(card.compactLayout, true);
    assert.equal(visible().length, 1);
    assert.match(visible()[0], /stopService/);
    assert.equal(card.compactStats.CPUPerc, "2.5%");
    assert.equal(card.compactStats.MemUsage, "100MiB / 8GiB");
    card.expandedCompact = true;
    assert.equal(card.compactLayout, false);
    assert.equal(visible().length, 4);
    assert.match(visible()[0], /terminalRouteLink/);
    assert.match(visible()[1], /logsRouteLink/);
    assert.match(visible()[2], /restartService/);
    card.expandedCompact = false;
    card.serviceStatus = [{ state: "exited",
        name: "api-1" }];
    assert.equal(visible().length, 1);
    assert.match(visible()[0], /startService/);
    card.expandedCompact = true;
    assert.equal(visible().length, 2);
    card.isEditMode = true;
    card.expandedCompact = false;
    assert.equal(card.compactLayout, false, "Editing must always use the original card");
    assert.equal(visible().length, 0);
    card.serviceStatus.push({ state: "running",
        name: "api-2" });
    assert.equal(card.compactStats, null, "Do not show one replica's usage as the entire service");
});

test("services sort errors/restarts, running, exited, then inactive with names inside each group", () => {
    const { instance: page, template } = component("../frontend/src/pages/Compose.vue");
    page.isEditMode = false;
    const sourceNames = [ "inactive-z", "running10", "unhealthy", "exited-z", "restarting", "running2", "exited-a", "inactive-a", "failed" ];
    page.jsonConfig.services = Object.fromEntries(sourceNames.map(name => [ name, { image: "test" }]));
    page.resolvedEditorServices = { included: { image: "included" } };
    page.serviceStatusList = {
        unhealthy: [{ state: "running",
            health: "unhealthy" }],
        restarting: [{ state: "restarting" }],
        running10: [{ state: "running",
            health: "starting" }],
        running2: [{ state: "running" }],
        "exited-z": [{ state: "exited",
            exitCode: 0 }],
        "exited-a": [{ state: "exited" }],
        "inactive-z": [{ state: "created" }],
        failed: [{ state: "exited",
            exitCode: 1 }],
    };
    assert.deepEqual(Array.from(page.sortedServiceNames), [ "failed", "restarting", "unhealthy", "running2", "running10", "exited-a", "exited-z", "inactive-a", "inactive-z", "included" ]);
    page.compactView = true;
    assert.equal(page.sortedServiceNames[0], "failed", "Both views must use the same order");
    page.serviceStatusList["inactive-a"] = [{ state: "restarting" }];
    assert.equal(page.sortedServiceNames[1], "inactive-a", "New status snapshots must immediately update the order");
    assert.deepEqual(Object.keys(page.jsonConfig.services), sourceNames, "Sorting must not rewrite Compose services");
    assert.match(template, /v-for="\(name, index\) in sortedServiceNames"/);
    assert.match(template, /:key="name"/);
    page.isEditMode = true;
    assert.deepEqual(Array.from(page.sortedServiceNames), [ ...sourceNames, "included" ], "Editing keeps source order for stable forms");
    assert.equal(containerStatus.containerStatusGroup([{ state: "running" }, { state: "restarting" }]), 0);
    assert.equal(containerStatus.containerStatusGroup([{ state: "running" }, { state: "exited" }]), 1);
    assert.equal(containerStatus.containerStatusGroup([{ state: "dead" }]), 0);
    assert.equal(containerStatus.containerStatusGroup([{ state: "paused" }]), 1);
});
