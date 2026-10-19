import childProcess from "node:child_process";
import type { DockerImageDetails, DockerImageSummary, ImageContainer } from "../common/images";

/** Run text-only Docker commands. Image archives use raw streams instead. */
export function runDocker(args: string[], signal?: AbortSignal, progress?: (text: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn("docker", args, { stdio: [ "ignore", "pipe", "pipe" ],
            signal });
        let force: ReturnType<typeof setTimeout> | undefined;
        const aborted = () => {
            force = setTimeout(() => child.kill("SIGKILL"), 2000);
            force.unref();
        };
        signal?.addEventListener("abort", aborted, { once: true });
        child.once("close", () => {
            clearTimeout(force);
            signal?.removeEventListener("abort", aborted);
        });
        let output = "";
        let errors = "";
        let failure: Error | undefined;
        let timeout: ReturnType<typeof setTimeout>;
        const resetTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                failure = new Error("Docker command timed out");
                child.kill("SIGKILL");
            }, progress ? 300000 : 30000);
        };
        resetTimeout();
        child.stdout.on("data", chunk => {
            if (progress) {
                resetTimeout();
                progress(chunk.toString());
            } else {
                output += chunk.toString();
                if (output.length > 16 * 1024 * 1024) {
                    failure = new Error("Docker response is too large");
                    child.kill("SIGKILL");
                }
            }
        });
        child.stderr.on("data", chunk => {
            errors = (errors + chunk.toString()).slice(-8192);
            if (progress) {
                resetTimeout();
                progress(chunk.toString());
            }
        });
        child.once("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", code => {
            clearTimeout(timeout);
            if (failure || code !== 0) {
                reject(failure || new Error(errors.trim() || `Docker exited with code ${code}`));
            } else {
                resolve(output);
            }
        });
    });
}

export function imageID(value: unknown): string {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new Error("Invalid image ID");
    }
    return value;
}

export function imageReference(value: unknown, allowDigest = false): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,511}$/.test(value)
        || (!allowDigest && value.includes("@"))) {
        throw new Error("Invalid image reference");
    }
    if (!value.includes("@") && !value.slice(value.lastIndexOf("/") + 1).includes(":")) {
        return value + ":latest";
    }
    return value;
}

/** Docker Hub short names and explicit registry names can identify the same tag. */
function canonicalReference(reference: string): string {
    const first = reference.split("/")[0];
    let normalized = reference;
    if (!reference.includes("/") || (!first.includes(".") && !first.includes(":") && first !== "localhost")) {
        normalized = "docker.io/" + reference;
    }
    normalized = normalized.replace(/^index\.docker\.io\//, "docker.io/");
    if (normalized.startsWith("docker.io/") && normalized.slice(10).split("/").length === 1) {
        normalized = "docker.io/library/" + normalized.slice(10);
    }
    return normalized;
}

export interface RawDockerImage {
    Id: string;
    RepoTags: string[];
    RepoDigests: string[];
    Size: number;
    Created: string;
    Os: string;
    Architecture: string;
    Variant?: string;
    Config?: { Labels?: Record<string, string> };
}

function summary(raw: RawDockerImage, containers: ImageContainer[]): DockerImageSummary {
    return {
        id: raw.Id,
        tags: (raw.RepoTags || []).filter((tag: string) => tag !== "<none>:<none>").sort(),
        digests: raw.RepoDigests || [],
        size: raw.Size || 0,
        created: raw.Created,
        os: raw.Os || "unknown",
        architecture: [ raw.Architecture, raw.Variant ].filter(Boolean).join("/"),
        containers: containers.filter(container => container.image === raw.Id),
    };
}

export class ImageService {
    async rawInspect(references: string[]) {
        const images: RawDockerImage[] = [];
        for (let offset = 0; offset < references.length; offset += 50) {
            images.push(...JSON.parse(await runDocker([ "image", "inspect", ...references.slice(offset, offset + 50) ])));
        }
        return images;
    }

    async containers(): Promise<ImageContainer[]> {
        const ids = (await runDocker([ "container", "ls", "--all", "--quiet", "--no-trunc" ])).split(/\s+/).filter(Boolean);
        const result: ImageContainer[] = [];
        for (let offset = 0; offset < ids.length; offset += 50) {
            const output = await runDocker([ "container", "inspect", "--format", "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"image\":{{json .Image}},\"state\":{{json .State.Status}}}", ...ids.slice(offset, offset + 50) ]);
            result.push(...output.split("\n").filter(Boolean).map(line => {
                const row = JSON.parse(line);
                row.name = row.name.replace(/^\//, "");
                return row;
            }));
        }
        return result;
    }

    async list(): Promise<DockerImageSummary[]> {
        const ids = [ ...new Set((await runDocker([ "image", "ls", "--all", "--quiet", "--no-trunc" ])).split(/\s+/).filter(Boolean)) ];
        const [ images, containers ] = await Promise.all([ this.rawInspect(ids), this.containers() ]);
        return images.map(raw => summary(raw, containers));
    }

    async inspect(id: string): Promise<DockerImageDetails> {
        imageID(id);
        const [[ raw ], containers ] = await Promise.all([ this.rawInspect([ id ]), this.containers() ]);
        return { ...summary(raw, containers),
            labels: raw.Config?.Labels || {} };
    }

    async conflicts(id: string, references: string[]): Promise<string[]> {
        const images = await this.list();
        return references.filter(reference => images.some(image => image.id !== id && image.tags.some(tag => canonicalReference(tag) === canonicalReference(reference))));
    }

    async delete(id: string) {
        const details = await this.inspect(id);
        if (details.containers.length) {
            throw new Error("Image is used by containers: " + details.containers.map(container => container.name).join(", "));
        }
        await runDocker([ "image", "rm", "--no-prune", ...(details.tags.length ? details.tags : [ id ]) ]);
    }

    async tag(id: string, reference: string, confirmed: boolean) {
        imageID(id);
        reference = imageReference(reference);
        const conflicts = await this.conflicts(id, [ reference ]);
        if (conflicts.length && !confirmed) {
            return { conflicts };
        }
        await runDocker([ "image", "tag", id, reference ]);
        return {};
    }

    async untag(id: string, reference: string) {
        reference = imageReference(reference);
        const details = await this.inspect(id);
        if (!details.tags.includes(reference)) {
            throw new Error("This tag no longer belongs to the selected image. Refresh and try again.");
        }
        if (details.tags.length === 1 && details.containers.length) {
            throw new Error("Cannot remove the last tag of an image used by containers");
        }
        await runDocker([ "image", "rm", "--no-prune", reference ]);
    }
}
