import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeSocket } from "../util-server";
import { callbackError, callbackResult, checkLogin } from "../util-server";
import type { AgentSocket } from "../../common/agent-socket";
import type { DockgeServer } from "../dockge-server";

export class BulkContainerSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, events: AgentSocket) {
        events.on("bulkContainerAction", async (input, callback) => {
            try {
                checkLogin(socket);
                const request = input as { action?: string; options?: unknown; token?: string } | null;
                if (!request) {
                    throw new Error("Invalid bulk container request");
                }
                const result = request.action === "preview" ? { preview: await server.bulkContainers.preview(socket.userID!, request.options) }
                    : request.action === "execute" ? { job: server.bulkContainers.execute(socket.userID!, request.token) }
                        : request.action === "status" ? { job: server.bulkContainers.status(socket.userID!, request.token) } : null;
                if (!result) {
                    throw new Error("Invalid bulk container action");
                }
                callbackResult({ ok: true,
                    ...result }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}
