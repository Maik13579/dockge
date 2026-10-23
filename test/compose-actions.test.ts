import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainerActionsSocketHandler } from "../backend/agent-socket-handlers/container-actions-socket-handler";
import { Stack } from "../backend/stack";
import { Terminal } from "../backend/terminal";
import { AgentSocket } from "../common/agent-socket";
import type { DockgeSocket } from "../backend/util-server";
import type { DockgeServer } from "../backend/dockge-server";
test("new service actions use scoped Compose commands and Build never performs Up", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-actions-"));
    t.after(() => fs.rm(root, { recursive: true,
        force: true }));
    await fs.mkdir(path.join(root, "robot"));
    const server = { stacksDir: root,
        sendStackList: async () => { } } as unknown as DockgeServer;
    const stack = new Stack(server, "robot");
    let config = { services: { included: { build: { context: "/src" } },
        imageOnly: { image: "app:latest" } } };
    t.mock.method(Stack, "getStack", async () => stack);
    t.mock.method(stack, "resolveConfig", async () => config);
    let exit = 0;
    const execution = t.mock.method(Terminal, "exec", async () => exit);
    const socket = { userID: 1,
        endpoint: "agent:5001" } as DockgeSocket;
    const events = new AgentSocket();
    new ContainerActionsSocketHandler().create(socket, server, events);
    const invoke = async (event, ...input) => {
        let reply;
        await events.eventList.get(event)!(...input, result => reply = result);
        return reply;
    };
    for (const [ event, expected ] of [
        [ "buildService", [ "build", "included" ]],
        [ "buildStack", [ "build", "included" ]],
        [ "downService", [ "rm", "--stop", "--force", "included" ]],
        [ "rmService", [ "rm", "--force", "included" ]],
    ] as const) {
        const result = await invoke(event, "robot", ...(event === "buildStack" ? [] : [ "included" ]));
        assert.equal(result.ok, true);
        const args = execution.mock.calls.at(-1)!.arguments;
        assert.deepEqual(args[4], [ "compose", "--progress", "plain", ...expected ]);
        assert.equal(args[5], path.join(root, "robot"));
        assert.ok(!(args[4] as string[]).includes("--volumes"));
    }
    const before = execution.mock.calls.length;
    assert.equal((await invoke("buildService", "robot", "imageOnly")).ok, false);
    assert.equal((await invoke("buildService", "robot", "--invalid")).ok, false);
    assert.equal((await invoke("downService", "robot", "missing")).ok, false);
    socket.userID = 0;
    assert.equal((await invoke("buildStack", "robot")).ok, false);
    assert.equal(execution.mock.calls.length, before);
    socket.userID = 1;
    exit = 1;
    assert.equal((await invoke("buildService", "robot", "included")).ok, false);
    config = { services: { imageOnly: { image: "app:latest" } } } as typeof config;
    assert.equal((await invoke("buildStack", "robot")).skipped, true);
});
