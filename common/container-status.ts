/** Runtime state shared by Docker inspection and Compose service snapshots. */
export interface ContainerState {
    state?: string;
    status?: string;
    health?: string;
    exitCode?: number;
    oomKilled?: boolean;
    exitCodeIgnored?: boolean;
    name?: string;
}

export const DEFAULT_IGNORED_EXIT_CODES = [ 137, 143 ];

/** Accept a comma/space-separated settings input or the stored numeric list. */
export function parseIgnoredExitCodes(value: unknown): number[] {
    if (value === undefined || value === null) {
        return [ ...DEFAULT_IGNORED_EXIT_CODES ];
    }
    const entries = typeof value === "string" ? (value.trim() ? value.trim().split(/[,\s]+/) : []) : value;
    if (!Array.isArray(entries) || entries.length > 256 || entries.some(code =>
        typeof code === "string" ? !/^\d{1,3}$/.test(code) || Number(code) > 255
            : typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 255)) {
        throw new Error("Ignored exit codes must be whole numbers between 0 and 255");
    }
    return [ ...new Set(entries.map(Number)) ];
}

/** Successful one-shot services and stale health results on stopped containers are not errors. */
export function containerIssue(instance: ContainerState, ignoredExitCodes: number[] = DEFAULT_IGNORED_EXIT_CODES): string {
    const state = instance.state || instance.status;
    if ([ "error", "dead", "restarting" ].includes(state || "")) {
        return state!;
    }
    if (state === "exited") {
        if (instance.oomKilled) {
            return "oom";
        }
        // Stop/Kill can end with SIGKILL (137) or SIGTERM (143). These codes
        // alone do not distinguish an intentional shutdown from a failure.
        if (typeof instance.exitCode === "number" && instance.exitCode !== 0 && !(instance.exitCodeIgnored ?? ignoredExitCodes.includes(instance.exitCode))) {
            return "exited";
        }
    }
    if (state === "unhealthy" || ((state === "running" || !instance.state) && instance.health === "unhealthy")) {
        return "unhealthy";
    }
    return "";
}

export function countContainerIssues(instances: ContainerState[]): number {
    return instances.filter(instance => containerIssue(instance)).length;
}
