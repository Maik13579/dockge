import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageService, imageID, imageReference } from "../backend/image-service";
import { defaultDocker, idA, idB, mockDocker } from "./image-fixture";
import { EventEmitter } from "node:events";
import { AgentManager } from "../backend/agent-manager";
import { AgentSocket } from "../common/agent-socket";
import { ImageTransfers } from "../backend/image-transfers";
import { ImageAgentSocketHandler, ImageSocketHandler } from "../backend/socket-handlers/image-socket-handler";
import type { DockgeSocket } from "../backend/util-server";
import { DockgeServer } from "../backend/dockge-server";

test("images group tags by full ID and include untagged images with exact container references", async t => {
    mockDocker(t, args => {
        if (args[0] === "container" && args[1] === "ls") {
            return { output: "one\ntwo\n" };
        }
        if (args[0] === "container" && args[1] === "inspect") {
            return { output: [
                { id: "one",
                    name: "/running",
                    image: idA,
                    state: "running" },
                { id: "two",
                    name: "/stopped",
                    image: idB,
                    state: "exited" },
            ].map(row => JSON.stringify(row)).join("\n") };
        }
        return defaultDocker(args);
    });
    const images = await new ImageService().list();
    assert.equal(images.length, 2);
    assert.equal(images[0].tags.length, 2);
    assert.equal(images[0].architecture, "arm64");
    assert.equal(images[0].containers[0].name, "running");
    assert.deepEqual(images[1].tags, []);
    assert.equal(images[1].containers[0].state, "exited");
});

test("deletion refuses stopped containers and never forces removal or prunes parents", async t => {
    let used = true;
    const calls = mockDocker(t, args => {
        if (args[0] === "container" && args[1] === "ls" && used) {
            return { output: "container\n" };
        }
        if (args[0] === "container" && args[1] === "inspect") {
            return { output: JSON.stringify({ id: "container",
                name: "/stopped",
                image: idA,
                state: "exited" }) };
        }
        return defaultDocker(args);
    });
    const service = new ImageService();
    await assert.rejects(service.delete(idA), /used by containers: stopped/);
    assert.equal(calls.some(call => call.args[1] === "rm"), false);
    used = false;
    await service.delete(idA);
    assert.deepEqual(calls.at(-1)?.args, [ "image", "rm", "--no-prune", "example/app:1", "example/app:latest" ]);
    await service.delete(idB);
    assert.deepEqual(calls.at(-1)?.args, [ "image", "rm", "--no-prune", idB ]);
});

test("tag conflicts require confirmation and stale tags cannot be removed from another image", async t => {
    const calls = mockDocker(t, defaultDocker);
    const service = new ImageService();
    assert.deepEqual(await service.tag(idB, "example/app:latest", false), { conflicts: [ "example/app:latest" ] });
    assert.equal(calls.some(call => call.args[1] === "tag"), false);
    assert.deepEqual(await service.tag(idB, "example/app", false), { conflicts: [ "example/app:latest" ] });
    assert.deepEqual(await service.tag(idB, "docker.io/example/app:latest", false), { conflicts: [ "docker.io/example/app:latest" ] });
    await service.tag(idB, "example/app:latest", true);
    assert.deepEqual(calls.at(-1)?.args, [ "image", "tag", idB, "example/app:latest" ]);
    await assert.rejects(service.untag(idB, "example/app:latest"), /no longer belongs/);
});

test("image inputs reject CLI options and shell text before executing Docker", () => {
    assert.equal(imageID(idA), idA);
    assert.equal(imageReference("registry.example:5000/team/app:1"), "registry.example:5000/team/app:1");
    for (const value of [ "--all", "app;echo", "app\nother", "app $(id)", undefined ]) {
        assert.throws(() => imageReference(value), /Invalid/);
        assert.throws(() => imageID(value), /Invalid/);
    }
});

test("both socket entrypoints require login and destructive operations require confirmation", async t => {
    const calls = mockDocker(t, defaultDocker);
    const socket = Object.assign(new EventEmitter(), { id: "image-auth",
        userID: 0,
        connected: true });
    const server = { imageTransfers: new ImageTransfers() } as DockgeServer;
    new ImageSocketHandler().create(socket as unknown as DockgeSocket, server);
    const agent = new AgentSocket();
    new ImageAgentSocketHandler().create(socket as unknown as DockgeSocket, server, agent);
    const request = { action: "list",
        endpoint: "" };
    const reply = await new Promise<{ ok: boolean }>(resolve => socket.emit("imageRequest", request, resolve));
    assert.equal(reply.ok, false);
    let agentReply;
    await agent.eventList.get("imageCommand")!(request, res => agentReply = res);
    assert.equal(agentReply.ok, false);
    socket.userID = 1;
    await agent.eventList.get("imageCommand")!({ action: "delete",
        id: idA }, res => agentReply = res);
    assert.equal(agentReply.ok, false);
    assert.match(agentReply.msg, /confirmation/);
    assert.equal(calls.length, 0);
});

test("agent capabilities reject old/offline instances and aborted requests release their listeners", async () => {
    const manager = new AgentManager({} as DockgeSocket);
    const client = Object.assign(new EventEmitter(), { connected: true });
    const agent = { url: "http://agent:5001",
        supported: false };
    Object.assign(manager, { imageAgents: { a: agent },
        agentSocketList: { a: client },
        agentLoggedInList: { a: true } });
    assert.throws(() => manager.getImageAgent("a"), /Update this agent/);
    agent.supported = true;
    client.connected = false;
    assert.throws(() => manager.getImageAgent("a"), /offline/);
    client.connected = true;
    const controller = new AbortController();
    const pending = manager.imageCommand("a", { action: "pull" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(client.listenerCount("disconnect"), 0);
});

test("logging in as another user leaves the previous image-job subscription", async () => {
    const rooms = new Set([ "socket", "images:1" ]);
    const socket = {
        id: "socket",
        userID: 1,
        rooms,
        join: room => rooms.add(room),
        leave: room => rooms.delete(room),
        emit() {},
        instanceManager: { sendAgentList() {},
            connectAll() {} },
    } as unknown as DockgeSocket;
    const server = {
        imageTransfers: new ImageTransfers(),
        sendInfo() {},
        sendStackList() {},
    } as unknown as DockgeServer;
    await DockgeServer.prototype.afterLogin.call(server, socket, { id: 2 } as Parameters<DockgeServer["afterLogin"]>[1]);
    assert.equal(rooms.has("images:1"), false);
    assert.equal(rooms.has("images:2"), true);
    assert.equal(socket.userID, 2);
});
