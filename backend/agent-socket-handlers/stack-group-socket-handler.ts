import { AgentSocketHandler } from "../agent-socket-handler";
import type { AgentSocket } from "../../common/agent-socket";
import type { LooseObject } from "../../common/util-common";
import type { GroupMember } from "../../common/stack-groups";
import { resolveGroupMember, splitGroupReference, stackGroupEndpoint } from "../../common/stack-groups";
import type { DockgeServer } from "../dockge-server";
import { Agent } from "../models/agent";
import { callbackError, callbackResult, checkLogin } from "../util-server";
import type { DockgeSocket } from "../util-server";
import { StackGroupTransport } from "../stack-group-transport";
import { registerGroupTargetHandlers } from "../stack-group-target";
import { getCombinedTerminalName, getComposeTerminalName, getContainerExecTerminalName, getContainerLogsTerminalName } from "../../common/util-common";

const operations = new Set([ "startStack", "stopStack", "downStack", "restartStack", "pullStack", "killStack" ]);
const stackEvents = new Set([ ...operations, "startService", "stopService", "restartService", "pullService", "killService", "containerLogs", "leaveContainerLogs", "interactiveTerminal", "leaveCombinedTerminal" ]);

/** Restrict proxy commands to the selected member and its own terminals. */
export function validateGroupProxy(endpoint: string, member: GroupMember, event: string, args: unknown[]) {
    if (stackEvents.has(event)) {
        if (args[0] !== member.stackName) {
            throw new Error("The requested stack is not this group member");
        }
        if (event === "interactiveTerminal" && ![ "bash", "sh" ].includes(String(args[2]))) {
            throw new Error("Unsupported container shell");
        }
        return;
    }
    if ([ "terminalJoin", "terminalInput", "terminalResize" ].includes(event) && typeof args[0] === "string") {
        const name = args[0];
        if ([ getComposeTerminalName(endpoint, member.stackName), getCombinedTerminalName(endpoint, member.stackName) ].includes(name)) {
            return;
        }
        const prefix = getContainerExecTerminalName(endpoint, member.stackName, "", 0).replace(/-0$/, "");
        if (name.startsWith(prefix) && /^[a-zA-Z0-9_.-]+-0$/.test(name.slice(prefix.length))) {
            return;
        }
        if (name.startsWith("container-logs-")) {
            try {
                const [ agent, stack, service ] = JSON.parse(name.slice("container-logs-".length));
                if (agent === endpoint && stack === member.stackName && typeof service === "string" && getContainerLogsTerminalName(endpoint, stack, service) === name) {
                    return;
                }
            } catch { /* Reject terminal names from other stacks. */ }
        }
    }
    throw new Error("Unsupported stack group command");
}

export class StackGroupSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, events: AgentSocket) {
        registerGroupTargetHandlers(socket, server, events);
        const transport = new StackGroupTransport(server, socket);
        const configs = new Map<string, LooseObject>();
        socket.on("disconnect", () => transport.close());
        socket.on("logout", () => transport.close());

        events.on("stackGroupRequest", async (input, callback) => {
            const reply = (result: unknown) => callbackResult(result, callback);
            try {
                checkLogin(socket);
                if (!input || typeof input !== "object" || typeof (input as { action?: unknown }).action !== "string") {
                    throw new Error("Invalid stack group request");
                }
                const request = input as { action: string; name: string; original?: string; members?: string[]; member?: string; event?: string; args?: unknown[]; refresh?: boolean; requestId?: string };
                const progress = (update: LooseObject) => {
                    if (typeof request.requestId === "string" && request.requestId.length <= 100 && socket.connected && socket.userID) {
                        socket.emitAgent("stackGroupProgress", { requestId: request.requestId,
                            ...update });
                    }
                };
                if (request.action === "list") {
                    reply({ ok: true,
                        groups: await server.stackGroups.list() });
                    return;
                }
                const agents = await Agent.getAgentList();
                const directory = Object.values(agents).map(agent => ({ endpoint: agent.endpoint,
                    name: agent.name }));
                if (request.action === "save") {
                    if (!Array.isArray(request.members)) {
                        throw new Error("Invalid stack group members");
                    }
                    const resolved = request.members.map(reference => resolveGroupMember(reference, directory));
                    if (new Set(resolved.map(member => JSON.stringify([ member.endpoint, member.stackName ]))).size !== resolved.length) {
                        throw new Error("A stack may only appear once in a group");
                    }
                    await server.stackGroups.save(request.name, request.members, request.original);
                    configs.clear();
                    transport.close();
                } else if (request.action === "delete") {
                    await server.stackGroups.delete(request.name);
                    configs.clear();
                    transport.close();
                } else if (request.action === "options") {
                    const devices = [{ endpoint: "",
                        name: "Current" }, ...directory ];
                    const choices = await Promise.all(devices.map(async device => {
                        const unique = device.name && device.name !== "Current" && directory.filter(item => item.name === device.name).length === 1;
                        const label = device.endpoint ? (unique ? device.name : device.endpoint) : "Current";
                        const member = { reference: `${label}:catalog`,
                            agentName: label,
                            endpoint: device.endpoint,
                            stackName: "catalog" };
                        let choice;
                        try {
                            const result = await transport.call("", member, agents, "stackGroupCatalog");
                            choice = { agentName: device.name || device.endpoint,
                                endpoint: device.endpoint,
                                stacks: result.stacks.map((name: string) => ({ reference: `${label}:${name}`,
                                    name })) };
                        } catch (error) {
                            choice = { agentName: device.name || device.endpoint,
                                endpoint: device.endpoint,
                                stacks: [],
                                error: String(error instanceof Error ? error.message : error) };
                        }
                        progress({ choice });
                        return choice;
                    }));
                    reply({ ok: true,
                        choices });
                    return;
                } else {
                    const references = await server.stackGroups.get(request.name);
                    const members = references.map(reference => {
                        try {
                            return resolveGroupMember(reference, directory);
                        } catch (error) {
                            return { reference,
                                ...splitGroupReference(reference),
                                agentName: splitGroupReference(reference).agent,
                                endpoint: "",
                                error: error instanceof Error ? error.message : String(error) };
                        }
                    });
                    const resolvedKeys = members.filter(member => !member.error).map(member => JSON.stringify([ member.endpoint, member.stackName ]));
                    if (new Set(resolvedKeys).size !== resolvedKeys.length) {
                        throw new Error("A stack may only appear once in a group");
                    }
                    if (request.action === "get") {
                        reply({ ok: true,
                            name: request.name,
                            members });
                        return;
                    }
                    if (request.action === "snapshot") {
                        const statistics = new Map<string, Promise<LooseObject>>();
                        const snapshots = await Promise.all(members.map(async member => {
                            let snapshot;
                            try {
                                if (member.error) {
                                    throw new Error(member.error);
                                }
                                const key = JSON.stringify([ request.name, member.endpoint, member.stackName ]);
                                const result = await transport.call(request.name, member, agents, "stackGroupSnapshot", [ member.stackName, request.refresh || !configs.has(key), member.endpoint || socket.endpoint ]);
                                if (result.config && !result.configError) {
                                    configs.set(key, result.config);
                                } else if (result.configError) {
                                    configs.delete(key);
                                }
                                if (!statistics.has(member.endpoint)) {
                                    statistics.set(member.endpoint, transport.call(request.name, member, agents, "dockerStats").catch(() => ({ dockerStats: {} })));
                                }
                                const stats = await statistics.get(member.endpoint)!;
                                snapshot = { ...member,
                                    stack: result.stack,
                                    config: result.config || configs.get(key),
                                    configError: result.configError,
                                    serviceStatusList: result.serviceStatusList,
                                    dockerStats: stats.dockerStats };
                            } catch (error) {
                                snapshot = { ...member,
                                    error: error instanceof Error ? error.message : String(error) };
                            }
                            progress({ member: snapshot });
                            return snapshot;
                        }));
                        reply({ ok: true,
                            name: request.name,
                            members: snapshots });
                        return;
                    }
                    if (request.action === "proxy") {
                        const member = members.find(item => item.reference === request.member);
                        if (!member || member.error || typeof request.event !== "string" || !Array.isArray(request.args)) {
                            throw new Error(member?.error || "Stack group member not found");
                        }
                        validateGroupProxy(stackGroupEndpoint(socket.endpoint, request.name, member.reference), member, request.event, request.args);
                        const result = await transport.call(request.name, member, agents, request.event, request.args, request.event === "terminalInput" || request.event === "terminalResize" ? 1000 : 0);
                        reply(result);
                        return;
                    }
                    if (request.action === "operate" && operations.has(String(request.event))) {
                        const results = await Promise.all(members.map(async member => {
                            try {
                                if (member.error) {
                                    throw new Error(member.error);
                                }
                                await transport.call(request.name, member, agents, request.event!, [ member.stackName ], 0);
                                return { reference: member.reference,
                                    ok: true };
                            } catch (error) {
                                return { reference: member.reference,
                                    ok: false,
                                    msg: error instanceof Error ? error.message : String(error) };
                            }
                        }));
                        reply({ ok: results.every(result => result.ok),
                            results,
                            msg: results.every(result => result.ok) ? "Completed" : "Some stack group operations failed" });
                        return;
                    }
                    throw new Error("Unsupported stack group request");
                }
                const groups = await server.stackGroups.list();
                socket.emitAgent("stackGroupList", { ok: true,
                    groups });
                reply({ ok: true,
                    groups });
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}
