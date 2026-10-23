import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DockgeServer } from "./dockge-server";
import type { BulkOptions, BulkJob } from "../common/bulk-containers";
import { runDocker } from "./image-service";
import { Stack } from "./stack";
import { Terminal } from "./terminal";
import { acceptedComposeFileNames } from "../common/util-common";
import { lockContainerOperations } from "./container-operation-lock";

export interface BulkContainer {
    Id: string;
    Name: string;
    Config: { Hostname?: string; Image?: string; Cmd?: string[]; Env?: string[]; Labels?: Record<string, string> };
    State: { Status: string };
}
interface Preview {
    owner: number;
    options: BulkOptions;
    expires: number;
    ids: string[];
    directories: Set<string>;
    job?: BulkJob;
}

export function validateBulkOptions(value: unknown): BulkOptions {
    const input = value as Partial<BulkOptions> | null;
    if (!input || ![ "managed", "all" ].includes(String(input.scope)) || typeof input.remove !== "boolean") {
        throw new Error("Invalid bulk container options");
    }
    return { scope: input.scope!,
        remove: input.remove };
}

/** Conservative recognition also protects older Dockge images and additional instances. */
export function isDockgeContainer(container: BulkContainer, hostname: string): boolean {
    const config = container.Config;
    const labels = config.Labels || {};
    return labels["io.dockge.protected"] === "true" || labels["org.opencontainers.image.title"]?.toLowerCase() === "dockge"
        || config.Env?.includes("DOCKGE_IS_CONTAINER=1") === true
        || /(^|[/:_-])dockge([:@_-]|$)/i.test(config.Image || "")
        || /(^|[-_])dockge([-_]|$)/i.test(container.Name.replace(/^\//, ""))
        || /(?:^|[ /])(?:\.\/)?backend\/index\.(?:ts|js)(?: |$)/.test((config.Cmd || []).join(" "))
        || (!!hostname && (config.Hostname === hostname || (/^[a-f0-9]{12,64}$/.test(hostname) && container.Id.startsWith(hostname))));
}

export function isManagedContainer(container: BulkContainer, directories: Set<string>): boolean {
    const labels = container.Config.Labels || {};
    if (!labels["com.docker.compose.project"]) {
        return false;
    }
    const directory = labels["com.docker.compose.project.working_dir"];
    const files = (labels["com.docker.compose.project.config_files"] || "").split(",").filter(Boolean).map(file => path.resolve(directory || ".", file.trim()));
    if (files.length) {
        return [ ...directories ].some(dir => acceptedComposeFileNames.some(file => files.includes(path.join(dir, file))));
    }
    return !!directory && directories.has(path.resolve(directory));
}

export class BulkContainers {
    private previews = new Map<string, Preview>();
    private run: typeof runDocker;
    private hostname: string;
    private inContainer: boolean;
    constructor(private server: DockgeServer, dependencies: { run?: typeof runDocker; hostname?: string; inContainer?: boolean } = {}) {
        this.run = dependencies.run || runDocker;
        this.hostname = dependencies.hostname ?? os.hostname();
        this.inContainer = dependencies.inContainer ?? (fs.existsSync("/.dockerenv") || process.env.DOCKGE_IS_CONTAINER === "1");
    }

    private async containers(ids?: string[]): Promise<BulkContainer[]> {
        if (!ids) {
            ids = (await this.run([ "container", "ls", "--all", "--quiet", "--no-trunc" ])).split(/\s+/).filter(Boolean);
        }
        if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) {
            throw new Error("Invalid Docker container ID");
        }
        const result: BulkContainer[] = [];
        for (let offset = 0; offset < ids.length; offset += 50) {
            const batch = ids.slice(offset, offset + 50);
            const rows: BulkContainer[] = JSON.parse(await this.run([ "container", "inspect", ...batch ]));
            if (!Array.isArray(rows) || rows.length !== batch.length || rows.some(row => !batch.includes(row.Id) || typeof row.Name !== "string" || !row.Config || !row.State)) {
                throw new Error("Invalid Docker container inspection");
            }
            result.push(...rows);
        }
        return result;
    }

    private protectSelf(containers: BulkContainer[]) {
        if (this.inContainer && !containers.some(container => container.Config.Hostname === this.hostname
            || (/^[a-f0-9]{12,64}$/.test(this.hostname) && container.Id.startsWith(this.hostname)))) {
            throw new Error("Cannot safely identify this Dockge container; bulk actions are unavailable");
        }
    }

    private async directories() {
        const stacks = await Stack.getStackList(this.server, false);
        return new Set([ ...stacks.values() ].filter(stack => stack.isManagedByDockge).map(stack => path.resolve(stack.path)));
    }

    async preview(owner: number, input: unknown) {
        const options = validateBulkOptions(input);
        for (const [ token, entry ] of this.previews) {
            if (entry.expires < Date.now() && (!entry.job || (entry.job.state !== "running" && entry.expires + 1800000 < Date.now()))) {
                this.previews.delete(token);
            }
        }
        const containers = await this.containers();
        this.protectSelf(containers);
        const directories = options.scope === "managed" ? await this.directories() : new Set<string>();
        const protectedContainers = containers.filter(container => isDockgeContainer(container, this.hostname));
        const targets = containers.filter(container => !isDockgeContainer(container, this.hostname)
            && (options.scope === "all" || isManagedContainer(container, directories))
            && (options.remove || [ "running", "restarting", "paused" ].includes(container.State.Status)));
        const token = randomUUID();
        const expires = Date.now() + 5 * 60 * 1000;
        this.previews.set(token, { owner,
            options,
            expires,
            ids: targets.map(container => container.Id),
            directories });
        return { token,
            count: targets.length,
            protectedCount: protectedContainers.length,
            expires };
    }

    private entry(owner: number, token: unknown) {
        const entry = typeof token === "string" ? this.previews.get(token) : undefined;
        if (!entry || entry.owner !== owner) {
            throw new Error("Bulk preview or job not found");
        }
        return entry;
    }

    status(owner: number, token: unknown) {
        const entry = this.entry(owner, token);
        if (!entry.job) {
            throw new Error("Bulk operation has not started");
        }
        return entry.job;
    }

    execute(owner: number, token: unknown): BulkJob {
        const entry = this.entry(owner, token);
        if (entry.job) {
            return entry.job;
        }
        if (entry.expires <= Date.now()) {
            throw new Error("Bulk preview expired; refresh the preview");
        }
        const directories = entry.options.scope === "all" ? null : entry.directories;
        const unlock = lockContainerOperations(this.server, directories);
        const job: BulkJob = { id: String(token),
            state: "running",
            total: entry.ids.length,
            completed: 0,
            results: [] };
        entry.job = job;
        void this.perform(entry, job, directories).catch(error => {
            job.state = "failed";
            job.message = error instanceof Error ? error.message : String(error);
        }).finally(() => {
            unlock();
            void this.server.sendStackList().catch(() => {});
        });
        return job;
    }

    private async perform(entry: Preview, job: BulkJob, directories: Set<string> | null) {
        Stack.cancelPendingUpdates(this.server, directories);
        await Terminal.interruptComposeOperations(this.server, directories);
        // Re-establish protection after interrupting pending starts and immediately before mutations.
        this.protectSelf(await this.containers());
        const currentDirectories = entry.options.scope === "managed" ? await this.directories() : new Set<string>();
        const pending = [ ...entry.ids ];
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
            while (pending.length) {
                const id = pending.shift()!;
                let name = id.slice(0, 12);
                try {
                    const [ container ] = await this.containers([ id ]);
                    name = container.Name.replace(/^\//, "");
                    if (isDockgeContainer(container, this.hostname) || (entry.options.scope === "managed" && !isManagedContainer(container, currentDirectories))) {
                        job.results.push({ id,
                            name,
                            state: "skipped",
                            message: "Container is protected or no longer matches the selected scope" });
                    } else if (!entry.options.remove && ![ "running", "restarting", "paused" ].includes(container.State.Status)) {
                        job.results.push({ id,
                            name,
                            state: "skipped",
                            message: "Container is already stopped" });
                    } else {
                        if (!entry.options.remove && container.State.Status === "paused") {
                            await this.run([ "container", "unpause", id ]);
                        }
                        await this.run(entry.options.remove ? [ "container", "rm", "--force", id ] : [ "container", "kill", id ]);
                        job.results.push({ id,
                            name,
                            state: entry.options.remove ? "removed" : "killed" });
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    job.results.push({ id,
                        name,
                        state: /no such (?:container|object)/i.test(message) ? "skipped" : "failed",
                        message });
                } finally {
                    job.completed++;
                }
            }
        }));
        job.state = job.results.some(result => result.state === "failed") ? "failed" : "completed";
    }
}
