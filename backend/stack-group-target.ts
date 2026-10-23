import { AgentSocket } from "../common/agent-socket";
import type { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { callbackError, callbackResult, checkLogin } from "./util-server";
import type { DockgeSocket } from "./util-server";
import { RUNNING } from "../common/util-common";

/** Local-only RPCs. The owner coordinates any remote calls separately. */
export function registerGroupTargetHandlers(socket: DockgeSocket, server: DockgeServer, events: AgentSocket) {
    events.on("stackGroupCatalog", async (callback) => {
        try {
            checkLogin(socket);
            const stacks = await Stack.getStackList(server, true);
            callbackResult({ ok: true,
                stacks: [ ...stacks.values() ].filter(stack => stack.isManagedByDockge).map(stack => stack.name).sort() }, callback);
        } catch (error) {
            callbackError(error, callback);
        }
    });
    events.on("stackGroupSnapshot", async (name, includeConfig, targetEndpoint, callback) => {
        try {
            checkLogin(socket);
            if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
                throw new Error("Invalid stack name");
            }
            const stack = await Stack.getStack(server, name);
            const serviceStatusList = Object.fromEntries(await stack.getServiceStatusList());
            if (stack.status === RUNNING && stack.isManagedByDockge) {
                await stack.joinCombinedTerminal(socket);
            }
            let config;
            let configError = "";
            if (includeConfig) {
                try {
                    config = await stack.resolveConfig();
                } catch (error) {
                    configError = error instanceof Error ? error.message : String(error);
                    config = { services: Object.fromEntries(Object.keys(serviceStatusList).map(service => [ service, {}])) };
                }
            }
            callbackResult({ ok: true,
                stack: await stack.toJSON(typeof targetEndpoint === "string" ? targetEndpoint : ""),
                serviceStatusList,
                containerManagement: true,
                config,
                configError }, callback);
        } catch (error) {
            callbackError(error, callback);
        }
    });
}
