import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parse, compileTemplate } from "vue/compiler-sfc";
import { disconnectImages, imageJobPercent, restoreImageJobs, uploadArchive, updateImageJob } from "../frontend/src/images.js";

function view(request = async () => ({ images: [] }), storage = {}) {
    const context = vm.createContext({ exports: {},
        localStorage: storage,
        window: { confirm: () => true },
        require: () => ({ imageRequest: (_root, input) => request(input),
            cancelUpload() {},
            uploadArchive() {},
            imageJobPercent }) });
    vm.runInContext(ts.transpileModule(readFileSync(new URL("../frontend/src/images-view.js", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    const options = context.exports.default;
    const instance = Object.assign(options.data(), { $t: text => text,
        $root: {
            agentList: { a: { name: "Agent A" } },
            agentCapabilities: { a: true },
            info: { imageManagement: true },
            agentStatusList: { a: "online" },
            socketIO: { connected: true },
            imageJobs: {},
            endpointDisplayFunction: endpoint => endpoint || "Local",
            toastError() {},
        } });
    for (const [ key, fn ] of Object.entries(options.methods)) {
        instance[key] = fn.bind(instance);
    }
    for (const [ key, fn ] of Object.entries(options.computed)) {
        Object.defineProperty(instance, key, { get: () => fn.call(instance) });
    }
    return { instance,
        options,
        storage };
}

test("the Images list scrolls without pages and hides untagged images by default", () => {
    const { instance, options, storage } = view();
    instance.images = Array.from({ length: 60 }, (_, index) => ({ id: "id" + index,
        tags: [ "app:" + index ] }));
    instance.images.push({ id: "untagged",
        tags: [] });
    assert.equal(instance.hideUntagged, true);
    assert.equal(instance.filtered.length, 60);
    instance.hideUntagged = false;
    options.watch.hideUntagged.call(instance, false);
    assert.equal(storage.hideUntaggedImages, "false");
    assert.equal(view(undefined, storage).instance.hideUntagged, false);
    assert.equal(instance.filtered.length, 61);
    instance.search = "untagged";
    assert.equal(instance.filtered.length, 1);
    const source = readFileSync(new URL("../frontend/src/components/Images.vue", import.meta.url), "utf8");
    assert.match(source, /v-for="image in filtered"/);
    assert.doesNotMatch(source, /perPage|pagination|image in paged/);
    const template = parse(source).descriptor.template!.content;
    assert.deepEqual(compileTemplate({ source: template,
        filename: "Images.vue",
        id: "images-test" }).errors, []);
});

test("device switches discard stale replies and offline or old agents cannot receive actions", async () => {
    const pending = [];
    const { instance } = view(input => new Promise(resolve => pending.push({ input,
        resolve })));
    const local = instance.load();
    instance.endpoint = "a";
    const remote = instance.load();
    assert.equal(pending[0].input.endpoint, "");
    assert.equal(pending[1].input.endpoint, "a");
    pending[1].resolve({ images: [{ id: "remote",
        tags: [ "remote:1" ] }] });
    await remote;
    pending[0].resolve({ images: [{ id: "local",
        tags: [ "local:1" ] }] });
    await local;
    assert.equal(instance.images[0].id, "remote");
    instance.$root.agentStatusList.a = "offline";
    await instance.load();
    assert.equal(instance.available, false);
    assert.equal(instance.images.length, 0);
    instance.$root.agentStatusList.a = "online";
    instance.$root.agentCapabilities.a = false;
    assert.equal(instance.available, false);
});

test("copy confirmations retain the original source and cancellation targets the job", async () => {
    const requests = [];
    let instance;
    const fixture = view(async request => {
        requests.push(request);
        if (request.action === "copy" && !request.confirmed) {
            instance.endpoint = "a";
            return { confirmationRequired: true,
                conflicts: [ "app:latest" ] };
        }
        return {};
    });
    instance = fixture.instance;
    instance.selected = { id: "id",
        tags: [ "app:latest" ] };
    instance.copyDestination = "a";
    await instance.copy();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].endpoint, "");
    assert.equal(requests[1].endpoint, "");
    assert.equal(requests[1].confirmed, true);
    instance.cancel({ id: "operation",
        endpoint: "offline-agent" });
    await Promise.resolve();
    assert.equal(requests.at(-1).action, "cancel");
    assert.equal(requests.at(-1).jobId, "operation");
    assert.equal(requests.at(-1).endpoint, "");
});

test("browser uploads use bounded chunks and keep progress outside the Home component", async t => {
    const chunks: Buffer[] = [];
    const headers: Record<string, string>[] = [];
    const job = { id: "upload-job",
        state: "pending" };
    const root = { imageJobs: {},
        getSocket: () => ({ timeout() {
            return this;
        },
        emit(_event, request, callback) {
            callback(null, { ok: true,
                job,
                ticket: "first" });
        } }) };
    class XHR {
        upload = {};
        responseType = "";
        response = {};
        status = 200;
        values = {};
        onload = () => {};
        open() {}
        setRequestHeader(key, value) {
            this.values[key] = value;
        }

        async send(blob) {
            chunks.push(Buffer.from(await blob.arrayBuffer()));
            headers.push(this.values);
            this.response = { ok: true,
                ticket: "next" };
            this.onload();
        }
    }
    const previous = globalThis.XMLHttpRequest;
    Object.assign(globalThis, { XMLHttpRequest: XHR });
    t.after(() => {
        if (previous) {
            Object.assign(globalThis, { XMLHttpRequest: previous });
        } else {
            Reflect.deleteProperty(globalThis, "XMLHttpRequest");
        }
    });
    const data = Buffer.alloc(9 * 1024 * 1024, 0xab);
    const file = Object.assign(new Blob([ data ]), { name: "images.tar" });
    await uploadArchive(root, "a", file);
    assert.deepEqual(chunks.map(chunk => chunk.length), [ 8 * 1024 * 1024, 1024 * 1024 ]);
    assert.deepEqual(Buffer.concat(chunks), data);
    assert.deepEqual(headers.map(header => header["X-Image-Final"]), [ "0", "1" ]);
    updateImageJob(root, { id: job.id,
        state: "completed" });
    assert.equal(root.imageJobs[job.id].total, data.length);
});

test("job snapshots restore active operations and omit completed transfers", () => {
    const root = { imageJobs: { old: { id: "old",
        state: "completed" } } };
    restoreImageJobs(root, [{ id: "copy",
        kind: "copy",
        state: "transferring",
        bytes: 1024,
        total: 4096 }, { id: "done",
        state: "completed" }]);
    assert.deepEqual(Object.keys(root.imageJobs), [ "copy" ]);
    disconnectImages(root);
    assert.equal(root.imageJobs.copy.state, "transferring", "A websocket disconnect must not mark server copies as cancelled");
    assert.equal(imageJobPercent(root.imageJobs.copy), 25, "The exact archive total survives refresh");
    assert.equal(imageJobPercent({ state: "transferring",
        bytes: 1024 }), null, "Older agents without an archive size still use an indeterminate bar");
    assert.equal(imageJobPercent({ state: "preparing",
        bytes: 0 }), null);
    assert.equal(imageJobPercent({ state: "transferring",
        bytes: 25,
        total: 100 }), 25);
    assert.equal(imageJobPercent({ state: "loading",
        bytes: 100,
        total: 100 }), null);
    const source = readFileSync(new URL("../frontend/src/components/Images.vue", import.meta.url), "utf8");
    assert.match(source, /v-if="activeJob\(job\)" class="progress/);
    assert.match(source, /progress-bar-striped progress-bar-animated/);
});

test("Copy to is hidden without an online agent", () => {
    const { instance } = view();
    instance.$root.agentStatusList.a = "offline";
    assert.equal(instance.hasOnlineAgent, false);
    assert.equal(instance.destinations.length, 0);
    instance.$root.agentStatusList.a = "online";
    assert.equal(instance.hasOnlineAgent, true);
    assert.equal(instance.destinations.length, 1);
    const template = readFileSync(new URL("../frontend/src/components/Images.vue", import.meta.url), "utf8");
    assert.match(template, /<button v-if="hasOnlineAgent && destinations.length > 0"[^>]*@click="openCopy/);
});
