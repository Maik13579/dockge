import { AgentSocketHandler } from "../agent-socket-handler";
import type { AgentSocket } from "../../common/agent-socket";
import type { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";
import { Stack } from "../stack";
import { Terminal } from "../terminal";
import type { LooseObject } from "../../common/util-common";
import { getComposeTerminalName } from "../../common/util-common";

export class ContainerActionsSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, events: AgentSocket) {
        for (const action of [ "buildStack", "buildService", "downService", "rmService" ]) {
            events.on(action, async (name, service, callback) => {
                if (action === "buildStack") {
                    callback = service;
                    service = undefined;
                }
                try {
                    checkLogin(socket);
                    if (typeof name !== "string" || !/^[a-z0-9_-]+$/.test(name)
                        || (action !== "buildStack" && (typeof service !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)))) {
                        throw new Error("Invalid stack or service name");
                    }
                    const stack = await Stack.getStack(server, name);
                    if (!stack.isManagedByDockge) {
                        throw new Error("This stack is not managed by Dockge");
                    }
                    const config = await stack.resolveConfig() as LooseObject;
                    if (service && !config.services?.[String(service)]) {
                        throw new Error("Service not found in Compose configuration");
                    }
                    const build = action.startsWith("build");
                    const buildable = Object.keys(config.services || {}).filter(key => config.services[key]?.build);
                    if (build && (service ? !buildable.includes(String(service)) : !buildable.length)) {
                        if (!service) {
                            callbackResult({ ok: true,
                                skipped: true,
                                msg: "No build configuration" }, callback);
                            return;
                        }
                        throw new Error("No build configuration");
                    }
                    const command = build ? stack.getComposeOptions("build", ...(service ? [ String(service) ] : buildable))
                        : stack.getComposeOptions("rm", ...(action === "downService" ? [ "--stop" ] : []), "--force", String(service));
                    const terminal = getComposeTerminalName(socket.endpoint, name);
                    const code = await Terminal.exec(server, socket, terminal, "docker", command, stack.path, false, service ? `${terminal}:service:${service}` : terminal);
                    if (code !== 0) {
                        throw new Error("Compose command failed; check terminal output");
                    }
                    callbackResult({ ok: true,
                        msg: "Completed" }, callback);
                    server.sendStackList();
                } catch (error) {
                    callbackError(error, callback);
                }
            });
        }
    }
}
