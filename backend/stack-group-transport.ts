import { io, Socket } from "socket.io-client";
import { AgentSocket } from "../common/agent-socket";
import { stackGroupEndpoint } from "../common/stack-groups";
import type { GroupMember } from "../common/stack-groups";
import type { LooseObject } from "../common/util-common";
import type { DockgeSocket } from "./util-server";
import type { DockgeServer } from "./dockge-server";
import type { Agent } from "./models/agent";
import { DockerSocketHandler } from "./agent-socket-handlers/docker-socket-handler";
import { registerGroupTargetHandlers } from "./stack-group-target";
import { TerminalSocketHandler } from "./agent-socket-handlers/terminal-socket-handler";

import { ContainerActionsSocketHandler } from "./agent-socket-handlers/container-actions-socket-handler";

interface Peer {
    socket?: Socket;
    local?: AgentSocket;
    ready: Promise<void>;
    active: boolean;
    identity: string;
    loggedIn?: boolean;
    containerManagement?: boolean;
    cancelReady?: () => void;
    virtual?: DockgeSocket;
}

/** Connections belong to the group owner, never to the viewing agent's aliases. */
export class StackGroupTransport {
    private peers = new Map<string, Peer>();
    constructor(private server: DockgeServer, private owner: DockgeSocket) {}

    private peer(group: string, member: GroupMember, agents: Record<string, Agent>) {
        const endpoint = stackGroupEndpoint(this.owner.endpoint, group, member.reference);
        const agent = member.endpoint ? agents[member.endpoint] : undefined;
        const identity = JSON.stringify([ member.endpoint, agent?.url, agent?.username, agent?.password ]);
        const existing = this.peers.get(endpoint);
        if (existing && existing.identity !== identity) {
            existing.active = false;
            existing.cancelReady?.();
            existing.socket?.disconnect();
            this.peers.delete(endpoint);
        }
        if (existing?.active) {
            return { endpoint,
                peer: existing };
        }
        const peer: Peer = { ready: Promise.resolve(),
            active: true,
            identity };
        const status = (value: string) => this.owner.emitAgent("stackGroupTargetStatus", { target: endpoint,
            status: value });
        if (!member.endpoint) {
            const owner = this.owner;
            const virtual = {
                id: owner.id + endpoint,
                get userID() {
                    return owner.userID;
                },
                get connected() {
                    return owner.connected && peer.active;
                },
                endpoint,
                emitAgent: (event: string, ...args: unknown[]) => {
                    if (peer.active && owner.userID && owner.connected) {
                        owner.emitAgent(event, ...args);
                    }
                },
            } as DockgeSocket;
            peer.virtual = virtual;
            peer.local = new AgentSocket();
            new DockerSocketHandler().create(virtual, this.server, peer.local);
            new ContainerActionsSocketHandler().create(virtual, this.server, peer.local);
            new TerminalSocketHandler().create(virtual, this.server, peer.local);
            // Local-only handlers registered by the group socket handler.
            registerGroupTargetHandlers(virtual, this.server, peer.local);
            peer.containerManagement = true;
            status("online");
        } else {
            if (!agent) {
                throw new Error("Group member agent is no longer configured");
            }
            const client = io(agent.url, { extraHeaders: { endpoint },
                reconnection: true });
            peer.socket = client;
            client.on("info", info => {
                peer.containerManagement = info.containerManagement === true;
            });
            peer.ready = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Agent unavailable: ${member.agentName}`)), 12000);
                peer.cancelReady = () => {
                    clearTimeout(timer);
                    reject(new Error("Group connection closed"));
                };
                client.on("connect", () => {
                    peer.loggedIn = false;
                    client.emit("login", { username: agent.username,
                        password: agent.password }, (result: { ok: boolean; msg?: string }) => {
                        peer.loggedIn = result.ok;
                        status(result.ok ? "online" : "offline");
                        if (result.ok) {
                            clearTimeout(timer);
                            resolve();
                        } else {
                            clearTimeout(timer);
                            reject(new Error(result.msg || "Agent login failed"));
                        }
                    });
                });
            });
            peer.ready.catch(() => {});
            client.on("disconnect", () => {
                peer.loggedIn = false;
                status("offline");
            });
            client.on("agent", (event: string, ...args: unknown[]) => {
                if ([ "terminalWrite", "terminalExit" ].includes(event) && peer.active && this.owner.userID) {
                    this.owner.emitAgent(event, ...args);
                }
            });
        }
        this.peers.set(endpoint, peer);
        return { endpoint,
            peer };
    }

    async call(group: string, member: GroupMember, agents: Record<string, Agent>, event: string, args: unknown[] = [], timeout = 30000): Promise<LooseObject> {
        if (!this.owner.connected || !this.owner.userID) {
            throw new Error("Group connection closed");
        }
        const { endpoint, peer } = this.peer(group, member, agents);
        try {
            await peer.ready;
        } catch (error) {
            peer.active = false;
            peer.socket?.disconnect();
            this.peers.delete(endpoint);
            throw error;
        }
        if (!peer.active || (peer.socket && (!peer.socket.connected || !peer.loggedIn))) {
            throw new Error(`Agent unavailable: ${member.agentName}`);
        }
        if ([ "buildStack", "buildService", "downService", "rmService" ].includes(event) && !peer.containerManagement) {
            throw new Error("Update agent");
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = timeout ? setTimeout(() => finish(new Error(`Group member request timed out: ${member.reference}`)), timeout) : undefined;
            const disconnected = () => finish(new Error(`Agent disconnected: ${member.agentName}`));
            const finish = (error?: Error, result?: LooseObject) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                peer.socket?.off("disconnect", disconnected);
                if (error) {
                    reject(error);
                } else if (!result?.ok) {
                    reject(new Error(result?.msg || "Group member request failed"));
                } else {
                    resolve(result);
                }
            };
            peer.socket?.once("disconnect", disconnected);
            const callback = (result: LooseObject) => finish(undefined, result);
            if (peer.local) {
                if (!peer.local.eventList.has(event)) {
                    finish(new Error("Unsupported group member command"));
                    return;
                }
                peer.local.call(event, ...args, callback);
            } else {
                peer.socket!.emit("agent", endpoint, event, ...args, callback);
            }
            if ([ "terminalInput", "terminalResize" ].includes(event)) {
                finish(undefined, { ok: true });
            }
        });
    }

    close() {
        for (const peer of this.peers.values()) {
            peer.active = false;
            peer.cancelReady?.();
            peer.socket?.disconnect();
        }
        this.peers.clear();
    }
}
