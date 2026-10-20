import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { Readable } from "node:stream";
import { ImageTransfers } from "../backend/image-transfers";
import { archiveURL, byteCounter, remoteDestination, remoteSource, saveImage, transferImage } from "../backend/image-stream";
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

async function waitFor(condition: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!await condition()) {
        assert.ok(Date.now() < deadline, "Timed out waiting for the archive lifecycle");
        await delay(5);
    }
}

function trackArchives(t: TestContext) {
    const directories: string[] = [];
    const create = fs.mkdtemp.bind(fs);
    t.mock.method(fs, "mkdtemp", async (prefix: string) => {
        const directory = await create(prefix);
        directories.push(directory);
        return directory;
    });
    t.after(async () => {
        for (const directory of directories) {
            await fs.rm(directory, { recursive: true,
                force: true });
        }
    });
    return directories;
}

async function archivesRemoved(directories: string[]) {
    return (await Promise.all(directories.map(directory => fs.access(directory).then(() => false, () => true)))).every(Boolean);
}

test("all copy directions transfer prepared archives with exact totals and never delete the source", async t => {
    const directories = trackArchives(t);
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
        assert.equal(job.total, payload.length, "Use the archive bytes, not Docker's reported image size");
    }
    assert.equal(directories.length, 3, "Only the exporting device creates a temporary archive");
    await waitFor(() => archivesRemoved(directories));
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

test("saved archives exist on disk with their exact size and are removed when released", async t => {
    const directories = trackArchives(t);
    const payload = Buffer.alloc(1024 * 1024 + 37, 0x9a);
    mockDocker(t, args => args[1] === "save" ? { output: payload } : defaultDocker(args));
    const source = await saveImage([ idA ], new AbortController().signal);
    try {
        assert.equal(source.size, payload.length);
        const filename = path.join(directories[0], "image.tar");
        assert.deepEqual(await fs.readFile(filename), payload);
        assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
        const chunks: Buffer[] = [];
        for await (const chunk of source.stream) {
            chunks.push(chunk);
        }
        assert.deepEqual(Buffer.concat(chunks), payload);
    } finally {
        await source.dispose!();
    }
    assert.equal(await archivesRemoved(directories), true);
});

test("local and agent downloads advertise exact archive sizes and clean up their files", async t => {
    const directories = trackArchives(t);
    const payload = Buffer.alloc(1024 * 1024 + 179, 0xab);
    mockDocker(t, args => args[1] === "save" ? { output: payload } : defaultDocker(args));
    const { main, viewer } = await network(t);
    for (const endpoint of [ "", "a" ]) {
        const updates: ImageJob[] = [];
        const collect = (job: ImageJob) => updates.push({ ...job });
        viewer.on("imageJob", collect);
        const result = await main.transfers.request(viewer.socket(), { action: "download",
            endpoint,
            id: idA });
        const source = await remoteSource(archiveURL(main.url, result.ticket), new AbortController().signal);
        assert.equal(source.size, payload.length, "The browser receives Content-Length through the main instance");
        const chunks: Buffer[] = [];
        for await (const chunk of source.stream) {
            chunks.push(chunk);
        }
        assert.deepEqual(Buffer.concat(chunks), payload);
        const job = await viewer.result(result.job!.id);
        assert.equal(job.state, "completed", job.message);
        assert.equal(job.total, payload.length);
        assert.equal(job.bytes, payload.length);
        assert.ok(updates.some(update => update.state === "preparing" && update.bytes === 0 && update.total === undefined));
        assert.ok(updates.some(update => update.state === "transferring" && update.total === payload.length));
        viewer.off("imageJob", collect);
    }
    assert.equal(directories.length, 2);
    await waitFor(() => archivesRemoved(directories));
});

test("interrupted local and agent downloads remove their prepared archives", async t => {
    const directories = trackArchives(t);
    mockDocker(t, args => args[1] === "save" ? { output: Buffer.alloc(16 * 1024 * 1024) } : defaultDocker(args));
    const { main, viewer } = await network(t);
    for (const endpoint of [ "", "a" ]) {
        const result = await main.transfers.request(viewer.socket(), { action: "download",
            endpoint,
            id: idA });
        const source = await remoteSource(archiveURL(main.url, result.ticket), new AbortController().signal);
        source.stream.destroy();
        assert.equal((await viewer.result(result.job!.id)).state, "cancelled");
        await waitFor(() => archivesRemoved(directories));
    }
    assert.equal(directories.length, 2);
});

test("copies stay in preparation until save completes and retain their exact total after refresh", async t => {
    const directories = trackArchives(t);
    let release: () => void;
    let started: () => void;
    const saving = new Promise<void>(resolve => started = resolve);
    const calls = mockDocker(t, args => {
        if (args[1] === "save") {
            started();
            return new Promise(resolve => release = () => resolve({ output: Buffer.from("prepared archive") }));
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    const result = await main.transfers.request(viewer.socket(), { action: "copy",
        endpoint: "a",
        destination: "b",
        id: idA,
        confirmed: true });
    await saving;
    assert.equal(viewer.jobs.get(result.job!.id)?.state, "preparing");
    assert.equal(calls.some(call => call.args[1] === "load"), false, "Loading must not start before the archive is ready");
    viewer.connected = false;
    main.transfers.disconnect(viewer.socket());
    const refreshed = new Viewer();
    main.viewers.push(refreshed);
    const restored = main.transfers.restore(refreshed.socket());
    assert.equal(restored[0].state, "preparing");
    assert.equal(restored[0].total, undefined);
    release!();
    const job = await refreshed.result(result.job!.id);
    assert.equal(job.state, "completed", job.message);
    assert.equal(job.total, Buffer.byteLength("prepared archive"));
    assert.equal(job.bytes, job.total);
    await waitFor(() => archivesRemoved(directories));
});

test("failed exports remove their temporary archives", async t => {
    const directories = trackArchives(t);
    mockDocker(t, () => ({ output: "partial archive",
        error: "export failed",
        code: 1 }));
    await assert.rejects(saveImage([ idA ], new AbortController().signal), /export failed/);
    assert.equal(directories.length, 1);
    assert.equal(await archivesRemoved(directories), true);
});

test("cancelling local or agent preparation removes the unfinished archive", async t => {
    const directories = trackArchives(t);
    let started: () => void;
    mockDocker(t, args => {
        if (args[1] === "save") {
            started();
            return new Promise(() => {});
        }
        return defaultDocker(args);
    });
    const { main, viewer } = await network(t);
    for (const endpoint of [ "", "a" ]) {
        const saving = new Promise<void>(resolve => started = resolve);
        const result = await main.transfers.request(viewer.socket(), { action: "copy",
            endpoint,
            destination: "b",
            id: idA,
            confirmed: true });
        await saving;
        await main.transfers.request(viewer.socket(), { action: "cancel",
            endpoint: "",
            jobId: result.job!.id });
        assert.equal((await viewer.result(result.job!.id)).state, "cancelled");
        await waitFor(() => archivesRemoved(directories));
    }
    assert.equal(directories.length, 2);
});

test("a failed destination releases the prepared source archive", async t => {
    const directories = trackArchives(t);
    mockDocker(t, args => args[1] === "save" ? { output: Buffer.alloc(16 * 1024 * 1024) } : defaultDocker(args));
    const { main, b, viewer } = await network(t);
    const original = b.transfers.command.bind(b.transfers);
    t.mock.method(b.transfers, "command", async (owner, request) => {
        if (request.action === "import") {
            throw new Error("destination unavailable");
        }
        return original(owner, request);
    });
    for (const endpoint of [ "", "a" ]) {
        const result = await main.transfers.request(viewer.socket(), { action: "copy",
            endpoint,
            destination: "b",
            id: idA,
            confirmed: true });
        const job = await viewer.result(result.job!.id);
        assert.equal(job.state, "failed");
        assert.match(job.message, /destination unavailable/);
        await waitFor(() => archivesRemoved(directories));
    }
    assert.equal(directories.length, 2);
});

test("remote copy progress counts acknowledged bytes and enters loading only after the final bytes arrive", async t => {
    const payload = Buffer.alloc(9 * 1024 * 1024 + 3, 0xbc);
    let received = 0;
    let acknowledge: () => void;
    let release: () => void;
    let arrived: () => void;
    let started: () => void;
    const firstChunk = new Promise<void>(resolve => arrived = resolve);
    const loading = new Promise<void>(resolve => started = resolve);
    const controller = new AbortController();
    const server = http.createServer(async (req, res) => {
        for await (const chunk of req) {
            received += chunk.length;
        }
        if (received === 8 * 1024 * 1024) {
            await new Promise<void>(resolve => {
                acknowledge = resolve;
                arrived();
            });
        }
        if (req.headers["x-image-final"] === "1") {
            await new Promise<void>(resolve => {
                release = resolve;
                started();
            });
            res.end(JSON.stringify({ ok: true,
                message: "Loaded image" }));
        } else {
            res.end(JSON.stringify({ ok: true,
                ticket: "/next-chunk" }));
        }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address() as { port: number };
    let reported = 0;
    let loadingStarted = false;
    const destination = remoteDestination(new URL(`http://127.0.0.1:${address.port}/start`), controller.signal,
        bytes => {
            reported = bytes;
        }, () => {
            loadingStarted = true;
            assert.equal(reported, payload.length);
        });
    const transfer = transferImage({ stream: Readable.from([ payload ]),
        done: Promise.resolve() }, destination, controller.signal, byteCounter(() => {}));
    await firstChunk;
    assert.equal(reported, 0, "Buffering or sending a block must not count it before acknowledgement");
    assert.equal(loadingStarted, false);
    acknowledge!();
    await loading;
    assert.equal(loadingStarted, true);
    assert.equal(received, payload.length);
    assert.equal(reported, payload.length);
    release!();
    await transfer;
});
