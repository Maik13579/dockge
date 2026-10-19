import { SocketHandler } from "../socket-handler";
import { AgentSocketHandler } from "../agent-socket-handler";
import type { AgentSocket } from "../../common/agent-socket";
import type { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";
import type { ImageRequest } from "../../common/images";

export class ImageSocketHandler extends SocketHandler {
    create(socket: DockgeSocket, server: DockgeServer) {
        socket.on("imageRequest", async (request: ImageRequest, callback) => {
            try {
                checkLogin(socket);
                const result = await server.imageTransfers.request(socket, request);
                callbackResult({ ok: true,
                    ...result }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
        socket.on("disconnect", () => server.imageTransfers.disconnect(socket));
        socket.on("logout", () => {
            socket.leave?.("images:" + socket.userID);
            server.imageTransfers.disconnect(socket, true);
        });
    }
}

export class ImageAgentSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket) {
        agentSocket.on("imageCommand", async (request, callback) => {
            try {
                checkLogin(socket);
                const result = await server.imageTransfers.command(socket, request as Parameters<typeof server.imageTransfers.command>[1]);
                callbackResult({ ok: true,
                    ...result }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}
