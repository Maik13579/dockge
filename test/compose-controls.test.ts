import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
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
    for (const [ name, method ] of Object.entries(options.methods)) {
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

test("service polling updates the stack badge and controls without waiting for the global poll", () => {
    const { instance: page } = component("../frontend/src/pages/Compose.vue");
    page.stack = { name: "test" };
    page.$root.completeStackList.test_ = { status: util.CREATED_FILE };
    page.stopServiceStatusTimeout = true;
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
            status }];
        assert.equal(container.isRunning, true);
        // Older agents expose only status, so preserve their compatibility.
        container.serviceStatus = [{ status }];
        assert.equal(container.isRunning, true);
    }
    container.serviceStatus = [{ state: "exited",
        status: "exited" }, { state: "running",
        status: "starting" }];
    assert.equal(container.isRunning, true);
    container.serviceStatus = [{ state: "exited",
        status: "healthy" }];
    assert.equal(container.isRunning, false, "Container state takes precedence over a stale health result");
    container.serviceStatus = [];
    assert.equal(container.isRunning, false);
    assert.equal(container.status, "N/A");
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
