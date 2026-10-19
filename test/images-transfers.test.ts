import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import express from "express";
import { Readable } from "node:stream";
import { ImageTransfers } from "../backend/image-transfers";
import { archiveURL, byteCounter, remoteDestination, remoteSource, transferImage } from "../backend/image-stream";
import { ImageRouter } from "../backend/routers/image-router";
import type { DockgeSocket } from "../backend/util-server";
import type { DockgeServer } from "../backend/dockge-server";
import type { ImageJob } from "../common/images";
import { defaultDocker, idA, rawImage, mockDocker } from "./image-fixture";

class Viewer extends EventEmitter {
    id = Math.random().toString();
    userID = 1;
    connected = true;
    instanceManager = {};
    jobs = new Map<string, ImageJob>();
    emit(event: string, ...args: unknown[]) {
        if (event === "imageJobs") {
            this.jobs = new Map((args[0] as ImageJob[]).map(job => [ job.id, { ...job }]));
        }
        if (event === "imageJob") {
            const job = args[0] as ImageJob;
            this.jobs.set(job.id, { ...job });
        }
        return super.emit(event, ...args);
    }

    emitAgent() {}
    socket() {
        return this as unknown as DockgeSocket;
    }

    async result(id: string) {
        const finished = () => [ "completed", "failed", "cancelled" ].includes(this.jobs.get(id)?.state || "");
        if (!finished()) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.off("imageJob", update);
                    reject(new Error("Image job did not finish"));
                }, 5000);
                const update = () => {
                    if (finished()) {
                        clearTimeout(timer);
                        this.off("imageJob", update);
                        resolve();
                    }
                };
                this.on("imageJob", update);
            });
        }
        return this.jobs.get(id)!;
    }
}

async function host(t: TestContext) {
    const peer = new Viewer();
    const viewers = [ peer ];
    const transfers = new ImageTransfers((userID, job) => {
        for (const viewer of viewers.filter(viewer => viewer.connected && viewer.userID === userID)) {
            viewer.emit("imageJob", job);
        }
    });
    const app = express();
    app.use(new ImageRouter().create(app, { imageTransfers: transfers } as DockgeServer));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        viewers.forEach(viewer => transfers.disconnect(viewer.socket(), true));
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address() as { port: number };
    return { transfers,
        viewers,
        peer,
        url: `http://127.0.0.1:${address.port}` };
}

async function network(t: TestContext) {
    const main = await host(t);
    const a = await host(t);
    const b = await host(t);
    const viewer = main.peer;
    const targets = { a,
        b };
    viewer.instanceManager = {
        getImageAgent(endpoint: "a" | "b") {
            if (!targets[endpoint]) {
                throw new Error("Offline agent");
            }
            return { url: targets[endpoint].url,
                supported: true };
        },
        imageCommand(endpoint: "a" | "b", request: Parameters<ImageTransfers["command"]>[1]) {
            return targets[endpoint].transfers.command(targets[endpoint].peer.socket(), request);
        },
    };
    return { main,
        a,
        b,
        viewer };
}

test("all copy directions stream archives through main and never delete the source", async t => {
    const payload = Buffer.alloc(1024 * 1024 + 17);
    for (let index = 0; index < payload.length; index++) {
        payload[index] = index % 256;
    }
    const calls = mockDocker(t, (args, input) => {
        if (args[1] === "save") {
            return { output: payload };
        }
        if (args[1] === "load") {
            assert.deepEqual(input, payload);
            return { output: "Loaded image: example/app:latest\n" };
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    for (const [ endpoint, destination ] of [[ "", "a" ], [ "a", "" ], [ "a", "b" ]]) {
        const before = calls.filter(call => call.args[1] === "save").length;
        const preview = await main.transfers.request(viewer.socket(), { action: "copy",
            endpoint,
            destination,
            id: idA });
        assert.equal(preview.confirmationRequired, true);
        assert.equal(calls.filter(call => call.args[1] === "save").length, before, "Preview must not start another transfer");
        const result = await main.transfers.request(viewer.socket(), { action: "copy",
            endpoint,
            destination,
            id: idA,
            confirmed: true });
        const job = await viewer.result(result.job!.id);
        assert.equal(job.state, "completed", job.message);
        assert.equal(job.bytes, payload.length);
    }
    assert.equal(calls.filter(call => call.args[1] === "load").length, 3);
    assert.equal(calls.some(call => call.args[1] === "rm"), false);
    for (const call of calls.filter(call => call.args[1] === "save")) {
        assert.deepEqual(call.args.slice(2), [ "example/app:1", "example/app:latest" ]);
    }
});

test("multi-chunk browser uploads reach an agent byte-for-byte and report loading completion", async t => {
    const payload = Buffer.alloc(9 * 1024 * 1024 + 3, 0xff);
    const calls = mockDocker(t, (args, input) => {
        if (args[1] === "load") {
            assert.deepEqual(input, payload);
            return { output: "Loaded image\n" };
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "upload",
        endpoint: "a",
        filename: "images.tar.gz",
        confirmed: true });
    const controller = new AbortController();
    const destination = remoteDestination(archiveURL(main.url, result.ticket), controller.signal);
    await transferImage({ stream: Readable.from([ payload ]),
        done: Promise.resolve() }, destination, controller.signal, byteCounter(() => {}));
    const job = await viewer.result(result.job!.id);
    assert.equal(job.state, "completed", job.message);
    assert.equal(job.bytes, payload.length);
    assert.equal(calls.filter(call => call.args[1] === "load").length, 1, "All chunks feed one Docker load process");
});

test("download tickets allow only the correct method, one use and the owning live session", async t => {
    mockDocker(t, args => args[1] === "save" ? { output: Buffer.from([ 0, 255, 13, 10 ]) } : defaultDocker(args));
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "download",
        endpoint: "a",
        id: idA });
    const url = archiveURL(main.url, result.ticket);
    const wrong = await new Promise<number>(resolve => {
        const request = http.request(url, { method: "POST" }, response => {
            response.resume();
            response.on("end", () => resolve(response.statusCode!));
        });
        request.end();
    });
    assert.equal(wrong, 405);
    const source = await remoteSource(url, new AbortController().signal);
    const chunks = [];
    for await (const chunk of source.stream) {
        chunks.push(chunk);
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([ 0, 255, 13, 10 ]));
    assert.equal((await viewer.result(result.job!.id)).state, "completed");
    await assert.rejects(remoteSource(url, new AbortController().signal), /403/);
    const second = await main.transfers.request(viewer.socket(), { action: "download",
        endpoint: "",
        id: idA });
    main.transfers.disconnect(viewer.socket());
    await assert.rejects(remoteSource(archiveURL(main.url, second.ticket), new AbortController().signal), /403/);
});

test("cancellation is user-only and cancelled tickets cannot start Docker", async t => {
    const calls = mockDocker(t, defaultDocker);
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "download",
        endpoint: "",
        id: idA });
    const other = new Viewer();
    other.userID = 2;
    await assert.rejects(main.transfers.request(other.socket(), { action: "cancel",
        endpoint: "",
        jobId: result.job!.id }), /not found/);
    await main.transfers.request(viewer.socket(), { action: "cancel",
        endpoint: "",
        jobId: result.job!.id });
    assert.equal((await viewer.result(result.job!.id)).state, "cancelled");
    await assert.rejects(remoteSource(archiveURL(main.url, result.ticket), new AbortController().signal), /403/);
    assert.equal(calls.some(call => call.args[1] === "save"), false);
});

test("copy conflicts are listed before confirmation and a failing save is never successful", async t => {
    mockDocker(t, args => args[1] === "save" ? { error: "failed to save",
        code: 1 } : defaultDocker(args));
    const { main, a, viewer } = await network(t);
    t.mock.method(a.transfers.service, "conflicts", async () => rawImage.RepoTags);
    const request = { action: "copy",
        endpoint: "",
        destination: "a",
        id: idA } as const;
    const preview = await main.transfers.request(viewer.socket(), request);
    assert.deepEqual(preview.conflicts, rawImage.RepoTags);
    const result = await main.transfers.request(viewer.socket(), { ...request,
        confirmed: true });
    assert.equal((await viewer.result(result.job!.id)).state, "failed");
});

test("failed Docker loads report failure and cancellation aborts an active load", async t => {
    let fail = true;
    let loading: () => void;
    const started = new Promise<void>(resolve => loading = resolve);
    mockDocker(t, args => {
        if (args[1] === "load") {
            if (fail) {
                return { error: "invalid archive",
                    code: 1 };
            }
            loading();
            return new Promise(() => {});
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const run = async () => {
        const result = await main.transfers.request(viewer.socket(), { action: "upload",
            endpoint: "",
            filename: "bad.tar",
            confirmed: true });
        const controller = new AbortController();
        const sink = remoteDestination(archiveURL(main.url, result.ticket), controller.signal);
        const transfer = transferImage({ stream: Readable.from([ Buffer.from("invalid archive") ]),
            done: Promise.resolve() }, sink, controller.signal, byteCounter(() => {}));
        return { result,
            transfer };
    };
    const first = await run();
    await assert.rejects(first.transfer);
    const failed = await viewer.result(first.result.job!.id);
    assert.equal(failed.state, "failed", failed.message);
    fail = false;
    const second = await run();
    const cancelled = assert.rejects(second.transfer);
    await started;
    await main.transfers.request(viewer.socket(), { action: "cancel",
        endpoint: "",
        jobId: second.result.job!.id });
    await cancelled;
    assert.equal((await viewer.result(second.result.job!.id)).state, "cancelled");
});

test("unclaimed transfer tickets expire and cannot be replayed", async t => {
    mockDocker(t, defaultDocker);
    const { main, viewer } = await network(t);
    let expire: () => void;
    const originalTimeout = globalThis.setTimeout;
    const timers: ReturnType<typeof setTimeout>[] = [];
    t.mock.method(globalThis, "setTimeout", ((callback, delay, ...args) => {
        if (delay === 300000) {
            expire = callback;
        }
        const timer = originalTimeout(callback, delay, ...args);
        timers.push(timer);
        return timer;
    }) as typeof setTimeout);
    t.after(() => timers.forEach(clearTimeout));
    const result = await main.transfers.request(viewer.socket(), { action: "download",
        endpoint: "",
        id: idA });
    expire!();
    assert.equal((await viewer.result(result.job!.id)).state, "cancelled");
    await assert.rejects(remoteSource(archiveURL(main.url, result.ticket), new AbortController().signal), /403/);
});

test("stream backpressure bounds read-ahead while a destination is slow", async () => {
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    const source = new Readable({
        highWaterMark: 65536,
        read() {
            if (produced === 64) {
                this.push(null);
            } else {
                produced++;
                maxAhead = Math.max(maxAhead, produced - consumed);
                this.push(Buffer.alloc(65536));
            }
        },
    });
    const { Writable } = await import("node:stream");
    let finish: (value: string) => void;
    const done = new Promise<string>(resolve => finish = resolve);
    const sink = new Writable({
        highWaterMark: 65536,
        write(chunk, encoding, callback) {
            consumed++;
            setTimeout(callback, 1);
        },
        final(callback) {
            finish("loaded");
            callback();
        },
    });
    await transferImage({ stream: source,
        done: Promise.resolve() }, { stream: sink,
        done }, new AbortController().signal, byteCounter(() => {}));
    assert.equal(consumed, 64);
    assert.ok(maxAhead < 10, "Slow consumers must stop Docker output from accumulating in memory");
});

test("agent copies survive F5, restore for the same user and release old connections after completion", async t => {
    let release: () => void;
    let started: () => void;
    const loading = new Promise<void>(resolve => started = resolve);
    mockDocker(t, args => {
        if (args[1] === "save") {
            return { output: Buffer.from("archive bytes") };
        }
        if (args[1] === "load") {
            started();
            return new Promise(resolve => release = () => resolve({ output: "Loaded image" }));
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    let disconnected = 0;
    Object.assign(viewer.instanceManager, { disconnectAll: () => disconnected++ });
    const result = await main.transfers.request(viewer.socket(), { action: "copy",
        endpoint: "a",
        destination: "b",
        id: idA,
        confirmed: true });
    await loading;
    viewer.connected = false;
    main.transfers.disconnect(viewer.socket());
    assert.equal(main.transfers.hasDetachedJobs(viewer.socket()), true);
    assert.equal(disconnected, 0);
    const refreshed = new Viewer();
    main.viewers.push(refreshed);
    const restored = main.transfers.restore(refreshed.socket());
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, result.job!.id);
    assert.ok(restored[0].bytes > 0);
    assert.equal(restored[0].state, "loading");
    const other = new Viewer();
    other.userID = 2;
    assert.deepEqual(main.transfers.restore(other.socket()), []);
    release!();
    assert.equal((await refreshed.result(result.job!.id)).state, "completed");
    assert.equal(disconnected, 1);
    assert.deepEqual(main.transfers.restore(new Viewer().socket()), [], "Completed copies can disappear after refresh");
});

test("a refreshed session can cancel the original copy and logout cancels background jobs", async t => {
    let started: () => void;
    let loading = new Promise<void>(resolve => started = resolve);
    mockDocker(t, args => {
        if (args[1] === "save") {
            return { output: Buffer.from("archive") };
        }
        if (args[1] === "load") {
            started();
            return new Promise(() => {});
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const first = await main.transfers.request(viewer.socket(), { action: "copy",
        endpoint: "a",
        destination: "b",
        id: idA,
        confirmed: true });
    await loading;
    viewer.connected = false;
    main.transfers.disconnect(viewer.socket());
    const refreshed = new Viewer();
    main.viewers.push(refreshed);
    main.transfers.restore(refreshed.socket());
    await main.transfers.request(refreshed.socket(), { action: "cancel",
        endpoint: "",
        jobId: first.job!.id });
    assert.equal((await refreshed.result(first.job!.id)).state, "cancelled");
    loading = new Promise<void>(resolve => started = resolve);
    refreshed.instanceManager = viewer.instanceManager;
    const second = await main.transfers.request(refreshed.socket(), { action: "copy",
        endpoint: "a",
        destination: "b",
        id: idA,
        confirmed: true });
    await loading;
    main.transfers.disconnect(refreshed.socket(), true);
    assert.equal((await refreshed.result(second.job!.id)).state, "cancelled");
});

test("an upload already loading in Docker survives a browser disconnect and restores its known size", async t => {
    let release: () => void;
    let started: () => void;
    const loading = new Promise<void>(resolve => started = resolve);
    mockDocker(t, args => {
        if (args[1] === "load") {
            started();
            return new Promise(resolve => release = () => resolve({ output: "Loaded image" }));
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "upload",
        endpoint: "a",
        filename: "image.tar",
        size: 7,
        confirmed: true });
    const controller = new AbortController();
    const destination = remoteDestination(archiveURL(main.url, result.ticket), controller.signal);
    const transfer = transferImage({ stream: Readable.from([ Buffer.from("archive") ]),
        done: Promise.resolve() }, destination, controller.signal, byteCounter(() => {}));
    await loading;
    viewer.connected = false;
    main.transfers.disconnect(viewer.socket());
    const refreshed = new Viewer();
    main.viewers.push(refreshed);
    const restored = main.transfers.restore(refreshed.socket());
    assert.equal(restored[0].total, 7);
    assert.equal(restored[0].state, "loading");
    const interrupted = assert.rejects(transfer);
    controller.abort();
    await interrupted;
    release!();
    assert.equal((await refreshed.result(result.job!.id)).state, "completed");
});

test("registry pulls keep their execution context after refresh and can be cancelled by the new session", async t => {
    let started: () => void;
    const pulling = new Promise<void>(resolve => started = resolve);
    mockDocker(t, args => {
        if (args[1] === "pull") {
            started();
            return new Promise(() => {});
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "pull",
        endpoint: "a",
        reference: "example/app:latest" });
    await pulling;
    viewer.connected = false;
    main.transfers.disconnect(viewer.socket());
    main.transfers.pullProgress(viewer.socket(), { id: result.job!.id,
        message: "Pulling layer" });
    const refreshed = new Viewer();
    main.viewers.push(refreshed);
    const snapshot = main.transfers.restore(refreshed.socket());
    assert.equal(snapshot[0].kind, "pull");
    assert.equal(snapshot[0].state, "running");
    assert.equal(snapshot[0].message, "Pulling layer");
    await main.transfers.request(refreshed.socket(), { action: "cancel",
        endpoint: "",
        jobId: result.job!.id });
    assert.equal((await refreshed.result(result.job!.id)).state, "cancelled");
});
