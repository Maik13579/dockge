import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import type { DockgeSocket } from "./util-server";
import type { ImageJob, ImageRequest, ImageResult } from "../common/images";
import { ImageService, imageID, imageReference, runDocker } from "./image-service";
import { appendImageChunk, archiveURL, byteCounter, loadImage, remoteDestination, remoteSource, saveImage, transferImage } from "./image-stream";
import type { ImageSource, ImageDestination } from "./image-stream";

interface Command {
    action: string;
    id?: string;
    reference?: string;
    confirmed?: boolean;
    references?: string[];
    operationId?: string;
}

interface Job {
    info: ImageJob;
    owner: DockgeSocket;
    userID: number;
    controller: AbortController;
    lastUpdate: number;
}

interface Ticket {
    owner: DockgeSocket;
    method: string;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    execute: (req: Request, res: Response, signal: AbortSignal) => Promise<void>;
}

/** Per-instance coordinator. Agent HTTP capabilities never reach the browser. */
export class ImageTransfers {
    readonly service = new ImageService();

    constructor(private publish?: (userID: number, job: ImageJob) => void) {}
    private tickets = new Map<string, Ticket>();
    private active = new Map<string, Set<AbortController>>();
    private jobs = new Map<string, Job>();
    private pulls = new Map<string, AbortController>();
    private imports = new Map<string, AbortController>();

    private track(owner: DockgeSocket, controller: AbortController) {
        if (!this.active.has(owner.id)) {
            this.active.set(owner.id, new Set());
        }
        this.active.get(owner.id)!.add(controller);
    }

    private untrack(owner: DockgeSocket, controller: AbortController) {
        if ([ ...this.tickets.values() ].some(ticket => ticket.controller === controller)) {
            return;
        }
        const controllers = this.active.get(owner.id);
        controllers?.delete(controller);
        if (!controllers?.size) {
            this.active.delete(owner.id);
        }
    }

    private detached(job: Job): boolean {
        return ![ "completed", "failed", "cancelled" ].includes(job.info.state)
            && ([ "copy", "pull" ].includes(job.info.kind)
                || (job.info.kind === "upload" && job.info.state === "loading")
                || (job.info.kind === "download" && job.info.state === "transferring"));
    }

    hasDetachedJobs(owner: DockgeSocket): boolean {
        return [ ...this.jobs.values() ].some(job => job.owner.id === owner.id && this.detached(job));
    }

    private release(owner: DockgeSocket) {
        if (!owner.connected && !this.hasDetachedJobs(owner)) {
            owner.instanceManager?.disconnectAll?.();
        }
    }

    restore(owner: DockgeSocket): ImageJob[] {
        const jobs = [ ...this.jobs.values() ].filter(job => job.userID === owner.userID && job.info.state !== "completed").map(job => ({ ...job.info }));
        owner.emit("imageJobs", jobs);
        return jobs;
    }

    pullProgress(owner: DockgeSocket, progress: { id: string; message: string }) {
        const job = this.jobs.get(progress.id);
        if (job && job.owner.id === owner.id && this.detached(job)) {
            this.update(job, { message: progress.message }, true);
        }
    }

    disconnect(owner: DockgeSocket, logout = false) {
        const retained = new Set([ ...this.jobs.values() ].filter(job => job.owner.id === owner.id && !logout && this.detached(job)).map(job => job.controller));
        for (const [ id, ticket ] of this.tickets) {
            if (ticket.owner.id === owner.id && !retained.has(ticket.controller)) {
                clearTimeout(ticket.timer);
                ticket.controller.abort();
                this.tickets.delete(id);
            }
        }
        for (const controller of this.active.get(owner.id) || []) {
            if (!retained.has(controller)) {
                controller.abort();
            }
        }
        if (!retained.size) {
            this.active.delete(owner.id);
        }
        for (const job of this.jobs.values()) {
            if ((logout ? job.userID === owner.userID : job.owner.id === owner.id) && (logout || !this.detached(job))) {
                if (![ "completed", "failed", "cancelled" ].includes(job.info.state)) {
                    job.controller.abort();
                    if (job.info.kind === "pull") {
                        this.call(job.owner, job.info.endpoint, { action: "cancelPull",
                            operationId: job.info.id }).catch(() => {});
                    }
                }
                this.release(job.owner);
            }
        }
    }

    private issue(owner: DockgeSocket, method: string, execute: Ticket["execute"], controller = new AbortController()): string {
        const id = randomBytes(32).toString("hex");
        const timer = setTimeout(() => {
            this.tickets.delete(id);
            controller.abort();
            this.untrack(owner, controller);
        }, 300000);
        timer.unref();
        this.tickets.set(id, { owner,
            method,
            controller,
            timer,
            execute });
        this.track(owner, controller);
        return id;
    }

    async serve(ticketID: string, req: Request, res: Response) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        const ticket = this.tickets.get(ticketID);
        if (!ticket || ticket.controller.signal.aborted || !ticket.owner.userID || !ticket.owner.connected) {
            res.status(403).json({ ok: false,
                msg: "Invalid or expired image transfer" });
            return;
        }
        if (req.method !== ticket.method) {
            res.status(405).json({ ok: false,
                msg: "Invalid transfer method" });
            return;
        }
        this.tickets.delete(ticketID);
        clearTimeout(ticket.timer);
        const disconnected = () => {
            const loading = [ ...this.jobs.values() ].some(job => job.controller === ticket.controller && job.info.kind === "upload" && job.info.state === "loading");
            if (!res.writableFinished && !loading) {
                ticket.controller.abort();
            }
        };
        const abortHTTP = () => {
            req.destroy();
            res.destroy();
        };
        ticket.controller.signal.addEventListener("abort", abortHTTP, { once: true });
        req.once("aborted", disconnected);
        res.once("close", disconnected);
        // A slow but active transfer is allowed; only stalled connections time out.
        req.setTimeout(300000, () => ticket.controller.abort());
        try {
            await ticket.execute(req, res, ticket.controller.signal);
        } catch (error) {
            ticket.controller.abort(error);
            if (!res.headersSent && !res.destroyed) {
                res.status(500).json({ ok: false,
                    msg: error instanceof Error ? error.message : "Image transfer failed" });
            } else if (!res.writableFinished) {
                res.destroy(error instanceof Error ? error : undefined);
            }
        } finally {
            ticket.controller.signal.removeEventListener("abort", abortHTTP);
            req.off("aborted", disconnected);
            res.off("close", disconnected);
            this.untrack(ticket.owner, ticket.controller);
        }
    }

    private chunkedImport(owner: DockgeSocket, factory: () => Promise<ImageDestination>, controller: AbortController,
        progress: (bytes: number) => void = () => {}, loading: () => void = () => {}, verify: () => Promise<void> = async () => {}) {
        let destination: ImageDestination | undefined;
        let bytes = 0;
        let resolveDone: (message: string) => void;
        let rejectDone: (error: Error) => void;
        const done = new Promise<string>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        done.catch(() => {});
        const aborted = () => rejectDone(new Error("Image upload cancelled or expired"));
        controller.signal.addEventListener("abort", aborted, { once: true });
        const execute: Ticket["execute"] = async (req, res, signal) => {
            try {
                destination ||= await factory();
                destination.done.catch(error => {
                    rejectDone(error);
                    controller.abort(error);
                });
                const count = await appendImageChunk(req, destination.stream, signal, current => progress(bytes + current));
                bytes += count;
                if (req.headers["x-image-final"] === "1") {
                    loading();
                    destination.stream.end();
                    const message = await destination.done;
                    await verify();
                    resolveDone(message);
                    res.json({ ok: true,
                        message });
                } else {
                    res.json({ ok: true,
                        ticket: this.issue(owner, "POST", execute, controller) });
                }
            } catch (error) {
                rejectDone(error instanceof Error ? error : new Error("Image upload failed"));
                controller.abort(error);
                throw error;
            }
        };
        done.finally(() => {
            controller.signal.removeEventListener("abort", aborted);
            this.untrack(owner, controller);
        }).catch(() => {});
        return { ticket: this.issue(owner, "POST", execute, controller),
            done };
    }

    private async call(owner: DockgeSocket, endpoint: string, request: Command, signal?: AbortSignal): Promise<ImageResult> {
        return endpoint ? owner.instanceManager.imageCommand(endpoint, request, signal) : this.command(owner, request);
    }

    /** Commands executed on the Docker host selected through the agent proxy. */
    async command(owner: DockgeSocket, request: Command): Promise<ImageResult> {
        if (!request || typeof request.action !== "string") {
            throw new Error("Invalid image command");
        }
        const id = () => imageID(request.id);
        switch (request.action) {
            case "list":
                return { images: await this.service.list() };
            case "inspect":
                return { image: await this.service.inspect(id()) };
            case "delete":
                if (request.confirmed !== true) {
                    throw new Error("Image deletion requires confirmation");
                }
                await this.service.delete(id());
                return {};
            case "tag":
                return this.service.tag(id(), imageReference(request.reference), request.confirmed === true);
            case "untag":
                if (request.confirmed !== true) {
                    throw new Error("Tag removal requires confirmation");
                }
                await this.service.untag(id(), imageReference(request.reference));
                return {};
            case "conflicts":
                if (!Array.isArray(request.references) || request.references.length > 1000) {
                    throw new Error("Invalid image tags");
                }
                return { conflicts: await this.service.conflicts(id(), request.references.map(reference => imageReference(reference))) };
            case "export": {
                const image = await this.service.inspect(id());
                const ticket = this.issue(owner, "GET", async (req, res, signal) => {
                    const tags = request.references || image.tags;
                    if (!Array.isArray(tags) || tags.length > 1000 || tags.some(tag => !image.tags.includes(tag))) {
                        throw new Error("Source image tags changed. Refresh and try again.");
                    }
                    const source = await this.localSource(image.id, tags, signal);
                    res.type("application/x-tar");
                    await pipeline(source.stream, res, { signal,
                        end: false });
                    await source.done;
                    res.end();
                });
                return { ticket };
            }
            case "import": {
                const expected = request.id ? id() : undefined;
                if (typeof request.operationId !== "string") {
                    throw new Error("Invalid image operation");
                }
                const key = owner.id + ":" + request.operationId;
                const controller = new AbortController();
                this.imports.set(key, controller);
                const { ticket, done } = this.chunkedImport(owner, async () => loadImage(controller.signal), controller, undefined, undefined, async () => {
                    if (expected) {
                        await this.service.rawInspect([ expected ]);
                    }
                });
                done.finally(() => this.imports.delete(key)).catch(() => {});
                return { ticket };
            }
            case "cancelImport":
                this.imports.get(owner.id + ":" + request.operationId)?.abort();
                return {};
            case "pull": {
                const reference = imageReference(request.reference, true);
                if (typeof request.operationId !== "string") {
                    throw new Error("Invalid image operation");
                }
                const key = owner.id + ":" + request.operationId;
                const controller = new AbortController();
                this.pulls.set(key, controller);
                this.track(owner, controller);
                let last = 0;
                try {
                    await runDocker([ "image", "pull", reference ], controller.signal, text => {
                        if (Date.now() - last > 200) {
                            const progress = { id: request.operationId!,
                                message: text.slice(-500).trim() };
                            this.pullProgress(owner, progress);
                            owner.emitAgent("imagePullProgress", progress);
                            last = Date.now();
                        }
                    });
                    return {};
                } finally {
                    this.pulls.delete(key);
                    this.untrack(owner, controller);
                }
            }
            case "cancelPull":
                this.pulls.get(owner.id + ":" + request.operationId)?.abort();
                return {};
            default:
                throw new Error("Unknown image command");
        }
    }

    private async localSource(id: string, references: string[], signal: AbortSignal): Promise<ImageSource> {
        const images = await this.service.rawInspect(references.length ? references : [ id ]);
        if (images.some(image => image.Id !== id)) {
            throw new Error("Source image tags changed. Refresh and try again.");
        }
        return saveImage(references.length ? references : [ id ], signal);
    }

    private async source(owner: DockgeSocket, endpoint: string, id: string, tags: string[], signal: AbortSignal): Promise<ImageSource> {
        if (!endpoint) {
            return this.localSource(id, tags, signal);
        }
        const result = await this.call(owner, endpoint, { action: "export",
            id,
            references: tags }, signal);
        return remoteSource(archiveURL(owner.instanceManager.getImageAgent(endpoint).url, result.ticket), signal);
    }

    private async destination(owner: DockgeSocket, endpoint: string, id: string | undefined, signal: AbortSignal, operationId: string): Promise<ImageDestination> {
        if (!endpoint) {
            return loadImage(signal);
        }
        const result = await this.call(owner, endpoint, { action: "import",
            id,
            operationId }, signal);
        signal.addEventListener("abort", () => {
            this.call(owner, endpoint, { action: "cancelImport",
                operationId }).catch(() => {});
        }, { once: true });
        return remoteDestination(archiveURL(owner.instanceManager.getImageAgent(endpoint).url, result.ticket), signal);
    }

    private newJob(owner: DockgeSocket, request: ImageRequest, kind: ImageJob["kind"], label: string): Job {
        const active = [ ...this.jobs.values() ].filter(job => job.userID === owner.userID && ![ "completed", "failed", "cancelled" ].includes(job.info.state));
        if (active.length >= 4) {
            throw new Error("Wait for an image operation to finish or cancel one first");
        }
        // Keep completed history bounded for long-lived browser sessions.
        for (const [ id, job ] of this.jobs) {
            if (job.userID === owner.userID && job.info.state === "completed") {
                this.jobs.delete(id);
            }
        }
        const previous = [ ...this.jobs.values() ].filter(job => job.userID === owner.userID && [ "failed", "cancelled" ].includes(job.info.state));
        for (const old of previous.slice(0, Math.max(0, previous.length - 20))) {
            this.jobs.delete(old.info.id);
        }
        const job: Job = {
            owner,
            userID: owner.userID,
            controller: new AbortController(),
            lastUpdate: 0,
            info: { id: randomBytes(16).toString("hex"),
                kind,
                endpoint: request.endpoint,
                destination: request.destination,
                label,
                state: "pending",
                bytes: 0,
                message: "" },
        };
        this.jobs.set(job.info.id, job);
        this.track(owner, job.controller);
        job.controller.signal.addEventListener("abort", () => {
            if (![ "completed", "failed", "cancelled" ].includes(job.info.state)) {
                const reason = job.controller.signal.reason;
                const failed = reason instanceof Error && reason.name !== "AbortError";
                this.update(job, { state: failed ? "failed" : "cancelled",
                    message: failed ? reason.message : "Image operation cancelled" });
            }
        }, { once: true });
        this.update(job, {});
        return job;
    }

    private update(job: Job, changes: Partial<ImageJob>, throttle = false) {
        Object.assign(job.info, changes);
        if (!throttle || Date.now() - job.lastUpdate > 200) {
            if (this.publish) {
                this.publish(job.userID, { ...job.info });
            } else {
                job.owner.emit("imageJob", job.info);
            }
            job.lastUpdate = Date.now();
        }
    }

    private async perform(job: Job, operation: () => Promise<string | void>) {
        try {
            const message = await operation();
            if (job.controller.signal.aborted) {
                throw new Error("Image operation cancelled");
            }
            this.update(job, { state: "completed",
                message: message || "Completed" });
        } catch (error) {
            const cancelled = job.controller.signal.aborted && job.controller.signal.reason?.name === "AbortError";
            this.update(job, { state: cancelled ? "cancelled" : "failed",
                message: error instanceof Error ? error.message : "Image operation failed" });
            job.controller.abort(error);
            throw error;
        } finally {
            this.untrack(job.owner, job.controller);
            this.release(job.owner);
        }
    }

    async request(owner: DockgeSocket, request: ImageRequest): Promise<ImageResult> {
        if (!request || typeof request.endpoint !== "string") {
            throw new Error("Select a Docker device");
        }
        if (request.endpoint) {
            owner.instanceManager.getImageAgent(request.endpoint);
        }
        if ([ "list", "inspect", "delete", "tag", "untag" ].includes(request.action)) {
            return this.call(owner, request.endpoint, request);
        }
        if (request.action === "cancel") {
            const job = this.jobs.get(request.jobId || "");
            if (!job || job.userID !== owner.userID) {
                throw new Error("Image operation not found");
            }
            if (![ "completed", "failed", "cancelled" ].includes(job.info.state)) {
                job.controller.abort();
                for (const [ id, ticket ] of this.tickets) {
                    if (ticket.controller === job.controller) {
                        clearTimeout(ticket.timer);
                        this.tickets.delete(id);
                    }
                }
                this.untrack(job.owner, job.controller);
                if (job.info.kind === "pull") {
                    await this.call(job.owner, job.info.endpoint, { action: "cancelPull",
                        operationId: job.info.id }).catch(() => {});
                }
            }
            return {};
        }
        if (request.action === "pull") {
            const reference = imageReference(request.reference, true);
            const job = this.newJob(owner, request, "pull", reference);
            this.update(job, { state: "running" });
            this.perform(job, async () => {
                await this.call(owner, request.endpoint, { action: "pull",
                    reference,
                    operationId: job.info.id }, job.controller.signal);
            }).catch(() => {});
            return { job: job.info };
        }
        if (request.action === "upload") {
            if (!request.confirmed || typeof request.filename !== "string" || !/\.(tar|tar\.gz|tgz)$/i.test(request.filename)) {
                throw new Error("Confirm a .tar, .tar.gz or .tgz archive before uploading");
            }
            if (request.size !== undefined && (!Number.isSafeInteger(request.size) || request.size < 0)) {
                throw new Error("Invalid image archive size");
            }
            const job = this.newJob(owner, request, "upload", request.filename.slice(0, 255));
            this.update(job, { total: request.size });
            const { ticket, done } = this.chunkedImport(owner, async () => {
                this.update(job, { state: "transferring" });
                return this.destination(owner, request.endpoint, undefined, job.controller.signal, job.info.id);
            }, job.controller, bytes => this.update(job, { bytes }, true), () => this.update(job, { state: "loading" }));
            this.perform(job, () => done).catch(() => {});
            return { ticket,
                job: job.info };
        }
        if (![ "download", "copy" ].includes(request.action)) {
            throw new Error("Unknown image request");
        }
        const id = imageID(request.id);
        const { image } = await this.call(owner, request.endpoint, { action: "inspect",
            id });
        if (!image) {
            throw new Error("Selected device returned no image details");
        }
        const label = image.tags[0] || id;
        if (request.action === "download") {
            const job = this.newJob(owner, request, "download", label);
            const ticket = this.issue(owner, "GET", async (req, res) => {
                await this.perform(job, async () => {
                    this.update(job, { state: "transferring" });
                    const source = await this.source(owner, request.endpoint, id, image.tags, job.controller.signal);
                    res.type("application/x-tar");
                    res.setHeader("Content-Disposition", `attachment; filename="${label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}.tar"`);
                    await pipeline(source.stream, byteCounter(bytes => this.update(job, { bytes }, true)), res, { signal: job.controller.signal,
                        end: false });
                    await source.done;
                    res.end();
                });
            }, job.controller);
            return { ticket,
                job: job.info };
        }
        if (typeof request.destination !== "string" || request.destination === request.endpoint) {
            throw new Error("Choose a different destination device");
        }
        if (request.destination) {
            owner.instanceManager.getImageAgent(request.destination);
        }
        const { conflicts } = await this.call(owner, request.destination, { action: "conflicts",
            id,
            references: image.tags });
        if (!request.confirmed) {
            return { conflicts,
                confirmationRequired: true };
        }
        const job = this.newJob(owner, request, "copy", label);
        this.perform(job, async () => {
            this.update(job, { state: "transferring" });
            const destination = await this.destination(owner, request.destination!, id, job.controller.signal, job.info.id);
            const source = await this.source(owner, request.endpoint, id, image.tags, job.controller.signal);
            const counter = byteCounter(bytes => this.update(job, { bytes }, true), () => this.update(job, { state: "loading" }));
            const message = await transferImage(source, destination, job.controller.signal, counter);
            await this.call(owner, request.destination!, { action: "inspect",
                id }, job.controller.signal);
            return message;
        }).catch(() => {});
        return { job: job.info };
    }
}
