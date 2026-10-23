import path from "node:path";
import type { DockgeServer } from "./dockge-server";

const locks = new WeakMap<DockgeServer, Set<string> | null>();

export function assertContainerOperationsAllowed(server: DockgeServer, directory: string) {
    if (locks.has(server) && (locks.get(server) === null || locks.get(server)!.has(path.resolve(directory)))) {
        throw new Error("A bulk container operation is running on this device");
    }
}

export function lockContainerOperations(server: DockgeServer, directories: Set<string> | null) {
    if (locks.has(server)) {
        throw new Error("A bulk container operation is already running on this device");
    }
    locks.set(server, directories);
    return () => locks.delete(server);
}

/** Find the Compose verb, without mistaking a service or an option value for a command. */
export function composeCommand(args: string | string[]): string | undefined {
    if (!Array.isArray(args) || args[0] !== "compose") {
        return;
    }
    const valueOptions = new Set([ "--env-file", "--file", "-f", "--project-name", "-p", "--project-directory", "--profile", "--ansi", "--parallel", "--progress" ]);
    for (let index = 1; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--") {
            return args[index + 1];
        }
        if (valueOptions.has(argument)) {
            index++;
        } else if (!argument.startsWith("-")) {
            return argument;
        }
    }
}
