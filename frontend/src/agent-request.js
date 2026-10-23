/** Acknowledged agent requests must release their listeners on timeout/disconnect. */
export function agentRequest(root, endpoint, event, input, timeout = 15000) {
    const socket = root.getSocket();
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            socket.off("disconnect", disconnected);
            socket.off("agentStatus", status);
        };
        const fail = message => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            const error = new Error(message);
            error.transport = true;
            reject(error);
        };
        const disconnected = () => fail("Connection lost; checking operation status when reconnected");
        const status = update => {
            if (update.endpoint === endpoint && update.status === "offline") {
                fail("Selected device is offline");
            }
        };
        const timer = setTimeout(() => fail("Agent request timed out"), timeout);
        socket.on("disconnect", disconnected);
        socket.on("agentStatus", status);
        if (!root.socketIO.connected || (endpoint && root.agentStatusList[endpoint] !== "online")) {
            fail("Selected device is offline");
            return;
        }
        try {
            root.emitAgent(endpoint, event, input, result => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (!result?.ok) {
                    reject(new Error(result?.msg || "Agent request failed"));
                } else {
                    resolve(result);
                }
            });
        } catch (error) {
            fail(error.message);
        }
    });
}
