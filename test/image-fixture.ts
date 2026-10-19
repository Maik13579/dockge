import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { TestContext } from "node:test";
import type { RawDockerImage } from "../backend/image-service";

export const idA = "sha256:" + "a".repeat(64);
export const idB = "sha256:" + "b".repeat(64);
export const rawImage: RawDockerImage = {
    Id: idA,
    RepoTags: [ "example/app:latest", "example/app:1" ],
    RepoDigests: [ "example/app@sha256:" + "c".repeat(64) ],
    Size: 123456,
    Created: "2026-10-19T00:00:00Z",
    Os: "linux",
    Architecture: "arm64",
    Config: { Labels: { app: "test" } },
};

/** Replace only Docker processes, keeping real streams, HTTP and coordination. */
export function mockDocker(t: TestContext, handler: (args: string[], input: Buffer) => { output?: string | Buffer; error?: string; code?: number } | Promise<{ output?: string | Buffer; error?: string; code?: number }>) {
    const calls: { args: string[]; input?: Buffer }[] = [];
    t.mock.method(childProcess, "spawn", ((_command: string, args: string[], options: { signal?: AbortSignal }) => {
        const record: { args: string[]; input?: Buffer } = { args };
        calls.push(record);
        const child = new EventEmitter();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let closed = false;
        const finish = (code: number) => {
            if (!closed) {
                closed = true;
                options.signal?.removeEventListener("abort", aborted);
                stdout.end();
                stderr.end();
                child.emit("close", code);
            }
        };
        const aborted = () => {
            child.emit("error", new Error("Docker process aborted"));
            finish(137);
        };
        const execute = async (input = Buffer.alloc(0)) => {
            try {
                record.input = input;
                const result = await handler(args, input);
                if (!closed) {
                    stdout.write(result.output || "");
                    stderr.write(result.error || "");
                    finish(result.code || 0);
                }
            } catch (error) {
                child.emit("error", error);
                finish(1);
            }
        };
        const chunks: Buffer[] = [];
        const stdin = new Writable({
            write(chunk, encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
            },
            final(callback) {
                if (args[1] === "load") {
                    execute(Buffer.concat(chunks));
                }
                callback();
            },
        });
        stdin.on("error", () => {});
        Object.assign(child, { stdin,
            stdout,
            stderr,
            kill: () => finish(137) });
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (args[1] !== "load") {
            queueMicrotask(() => execute());
        }
        return child;
    }) as never);
    return calls;
}

export function defaultDocker(args: string[]) {
    if (args[0] === "image" && args[1] === "ls") {
        return { output: idA + "\n" + idA + "\n" + idB + "\n" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
        return { output: JSON.stringify(args.slice(2).map(reference => reference === idB ? { ...rawImage,
            Id: idB,
            RepoTags: [] } : rawImage)) };
    }
    return { output: "" };
}
