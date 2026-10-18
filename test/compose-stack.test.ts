import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import childProcessAsync from "promisify-child-process";
import { Stack } from "../backend/stack";
import { Terminal } from "../backend/terminal";
import { DockgeServer } from "../backend/dockge-server";
import { DockgeSocket } from "../backend/util-server";
import { CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";

/** Build a saved include-based stack without starting Docker or a terminal. */
async function fixture(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-stack-test-"));
    t.after(() => fs.rm(directory, {
        recursive: true,
        force: true,
    }));
    const stackDirectory = path.join(directory, "test");
    await fs.mkdir(stackDirectory);
    await fs.writeFile(path.join(stackDirectory, "compose.yaml"), "include:\n  - ../shared/compose.yaml\n");
    await fs.writeFile(path.join(stackDirectory, "compose.override.yaml"), "services: {}\n");
    return {
        server: { stacksDir: directory } as DockgeServer,
        stackDirectory,
    };
}

test("Stop runs compose down with both files regardless of the recorded status", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    const execution = t.mock.method(Terminal, "exec", async () => 0);
    const stack = new Stack(server, "test");
    const socket = { endpoint: "" } as DockgeSocket;
    for (const status of [ UNKNOWN, CREATED_FILE, CREATED_STACK, RUNNING, EXITED ]) {
        Object.assign(stack, { _status: status });
        assert.equal(await stack.stop(socket), 0);
        const args = execution.mock.calls.at(-1)!.arguments;
        assert.equal(args[3], "docker");
        assert.deepEqual(args[4], [ "compose", "-f", "compose.yaml", "-f", "compose.override.yaml", "down" ]);
        assert.equal(args[5], stackDirectory);
    }
});

test("cached polling clears running status after down and drops vanished external projects", async (t) => {
    const { server, stackDirectory } = await fixture(t);
    let projects = [
        {
            Name: "test",
            Status: "created(1),running(25)",
            ConfigFiles: path.join(stackDirectory, "compose.yaml"),
        },
        {
            Name: "external",
            Status: "running(1)",
            ConfigFiles: "/elsewhere/compose.yaml",
        },
    ];
    t.mock.method(childProcessAsync, "spawn", () => Promise.resolve({
        stdout: JSON.stringify(projects),
    }) as ReturnType<typeof childProcessAsync.spawn>);

    let list = await Stack.getStackList(server);
    assert.equal(list.get("test")?.status, RUNNING);
    assert.equal(list.get("external")?.status, RUNNING);
    list = await Stack.getStackList(server, true);
    assert.equal(list.get("test")?.status, RUNNING);
    assert.equal(list.get("external")?.status, RUNNING);

    // compose down removes the project from docker compose ls entirely.
    projects = [];
    list = await Stack.getStackList(server, true);
    assert.equal(list.get("test")?.status, CREATED_FILE);
    assert.equal(list.has("external"), false);
});
