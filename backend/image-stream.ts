import childProcess from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ImageSource {
    stream: Readable;
    done: Promise<void>;
    size?: number;
    dispose?: () => Promise<void>;
}

export interface ImageDestination {
    stream: Writable;
    done: Promise<string>;
}

/** Binary archives must never pass through a PTY or text decoding. */
function dockerStream(args: string[], signal: AbortSignal) {
    const child = childProcess.spawn("docker", args, { stdio: [ "pipe", "pipe", "pipe" ],
        signal });
    let force: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => {
        force = setTimeout(() => child.kill("SIGKILL"), 2000);
        force.unref();
    };
    signal.addEventListener("abort", aborted, { once: true });
    child.once("close", () => {
        clearTimeout(force);
        signal.removeEventListener("abort", aborted);
    });
    let errors = "";
    const done = new Promise<void>((resolve, reject) => {
        child.stderr.on("data", chunk => errors = (errors + chunk.toString()).slice(-8192));
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(errors.trim() || `Docker exited with code ${code}`)));
    });
    // A process can fail before its stream is attached to a consumer.
    done.catch(() => {});
    return { child,
        done };
}

/** Finish the archive before exposing it, so its byte size is exact. */
export async function saveImage(references: string[], signal: AbortSignal): Promise<ImageSource> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "dockge-image-"));
    const filename = path.join(directory, "image.tar");
    let stream: Readable | undefined;
    let docker: ReturnType<typeof dockerStream> | undefined;
    let writing: Promise<void> | undefined;
    const dispose = async () => {
        stream?.destroy();
        await fs.rm(directory, { recursive: true,
            force: true });
    };
    try {
        signal.throwIfAborted();
        docker = dockerStream([ "image", "save", ...references ], signal);
        docker.child.stdin.end();
        writing = pipeline(docker.child.stdout, createWriteStream(filename, { flags: "wx",
            mode: 0o600 }), { signal });
        await Promise.all([ writing, docker.done ]);
        signal.throwIfAborted();
        const { size } = await fs.stat(filename);
        // Bound the read to the known length: clients can finish immediately on
        // Content-Length, so avoid a further asynchronous read just to find EOF.
        stream = createReadStream(filename, size > 0 ? { end: size - 1 } : undefined);
        // A consumer may still be opening the destination when reading fails.
        stream.on("error", () => {});
        return { stream,
            size,
            done: Promise.resolve(),
            dispose };
    } catch (error) {
        docker?.child.kill();
        docker?.child.stdout.destroy();
        await writing?.catch(() => {});
        await dispose();
        throw error;
    }
}

export function loadImage(signal: AbortSignal): ImageDestination {
    const { child, done } = dockerStream([ "image", "load" ], signal);
    let result = "";
    child.stdout.on("data", chunk => result = (result + chunk.toString()).slice(-8192));
    // Propagate an early process exit to the input pipeline as well.
    done.catch(error => child.stdin.destroy(error));
    const loaded = done.then(() => result);
    loaded.catch(() => {});
    return { stream: child.stdin,
        done: loaded };
}

export function byteCounter(update: (bytes: number) => void, loading?: () => void): Transform {
    let bytes = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            update(bytes);
            callback(null, chunk);
        },
        flush(callback) {
            loading?.();
            callback();
        },
    });
}

export function archiveURL(base: string, ticket: unknown): URL {
    if (typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)) {
        throw new Error("Agent returned an invalid transfer ticket");
    }
    const url = new URL(base.endsWith("/") ? base : base + "/");
    if (![ "http:", "https:" ].includes(url.protocol)) {
        throw new Error("Unsupported agent protocol");
    }
    url.pathname = url.pathname.replace(/\/$/, "") + "/api/image-transfers/" + encodeURIComponent(ticket);
    url.search = "";
    url.hash = "";
    return url;
}

function remoteRequest(url: URL, method: string, signal: AbortSignal) {
    const request = (url.protocol === "https:" ? https : http).request(url, { method,
        signal });
    request.setTimeout(300000, () => request.destroy(new Error("Image transfer stalled for five minutes")));
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
    });
    response.catch(() => {});
    return { request,
        response };
}

async function responseText(response: http.IncomingMessage): Promise<string> {
    let text = "";
    for await (const chunk of response) {
        text += chunk.toString();
        if (text.length > 16384) {
            response.destroy();
            throw new Error("Agent response is too large");
        }
    }
    if (response.statusCode !== 200) {
        throw new Error(`Agent transfer failed (${response.statusCode}): ${text.slice(0, 1000)}`);
    }
    return text;
}

export async function remoteSource(url: URL, signal: AbortSignal): Promise<ImageSource> {
    const { request, response } = remoteRequest(url, "GET", signal);
    request.end();
    const stream = await response;
    if (stream.statusCode !== 200) {
        await responseText(stream);
    }
    stream.on("error", () => {});
    const length = stream.headers["content-length"];
    const size = length === undefined ? undefined : Number(length);
    return { stream,
        size: size !== undefined && Number.isSafeInteger(size) && size >= 0 ? size : undefined,
        done: Promise.resolve(),
        dispose: async () => {
            stream.destroy();
        } };
}

export function remoteDestination(url: URL, signal: AbortSignal, progress: (bytes: number) => void = () => {}, loading: () => void = () => {}): ImageDestination {
    // Bounded requests preserve normal HTTP request timeouts on every instance.
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let length = 0;
    let sent = 0;
    let succeeded = false;
    let resolveDone: (message: string) => void;
    let rejectDone: (error: Error) => void;
    const done = new Promise<string>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });
    done.catch(() => {});
    const send = async (final: boolean) => {
        const { request, response } = remoteRequest(url, "POST", signal);
        request.setHeader("Content-Type", "application/octet-stream");
        request.setHeader("Content-Length", length);
        request.setHeader("X-Image-Final", final ? "1" : "0");
        request.end(buffer.subarray(0, length));
        const result = JSON.parse(await responseText(await response));
        if (!result.ok) {
            throw new Error(result.msg || "Agent failed to load the image");
        }
        if (!final) {
            if (typeof result.ticket !== "string") {
                throw new Error("Agent did not acknowledge the image chunk");
            }
            url = new URL(result.ticket, url);
        }
        sent += length;
        progress(sent);
        length = 0;
        return result.message || "Image loaded";
    };
    const stream = new Writable({
        write(chunk: Buffer, encoding, callback) {
            (async () => {
                let offset = 0;
                while (offset < chunk.length) {
                    const count = Math.min(buffer.length - length, chunk.length - offset);
                    chunk.copy(buffer, length, offset, offset + count);
                    offset += count;
                    length += count;
                    if (length === buffer.length) {
                        await send(false);
                    }
                }
            })().then(() => callback(), callback);
        },
        final(callback) {
            (async () => {
                // Acknowledge the last bytes before switching to Docker loading.
                if (length > 0) {
                    await send(false);
                }
                loading();
                return send(true);
            })().then(message => {
                succeeded = true;
                resolveDone(message);
                callback();
            }, callback);
        },
        destroy(error, callback) {
            signal.removeEventListener("abort", aborted);
            if (!succeeded) {
                rejectDone(error || new Error("Image transfer interrupted"));
            }
            callback(error);
        },
    });
    const aborted = () => stream.destroy(new Error("Image transfer cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
        aborted();
    }
    stream.on("error", () => {});
    return { stream,
        done };
}

export async function appendImageChunk(source: Readable, destination: Writable, signal: AbortSignal, progress: (bytes: number) => void): Promise<number> {
    let bytes = 0;
    for await (const chunk of source) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
            throw new Error("Image upload chunk exceeds 8 MiB");
        }
        await new Promise<void>((resolve, reject) => destination.write(chunk, error => error ? reject(error) : resolve()));
        progress(bytes);
    }
    return bytes;
}

export async function transferImage(source: ImageSource, destination: ImageDestination, signal: AbortSignal, counter: Transform): Promise<string> {
    // Observe both process failures immediately, including failures before EOF.
    const failed = Promise.all([ source.done, destination.done ]).catch(error => {
        source.stream.destroy(error);
        destination.stream.destroy(error);
        throw error;
    });
    failed.catch(() => {});
    await pipeline(source.stream, counter, destination.stream, { signal });
    const [ , result ] = await failed;
    return result;
}
