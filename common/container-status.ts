/** Runtime state shared by Docker inspection and Compose service snapshots. */
export interface ContainerState {
    state?: string;
    status?: string;
    health?: string;
    exitCode?: number;
    name?: string;
}

/** Successful one-shot services and stale health results on stopped containers are not errors. */
export function containerIssue(instance: ContainerState): string {
    const state = instance.state || instance.status;
    if ([ "error", "dead", "restarting" ].includes(state || "")) {
        return state!;
    }
    if (state === "exited" && typeof instance.exitCode === "number" && instance.exitCode !== 0) {
        return "exited";
    }
    if (state === "unhealthy" || ((state === "running" || !instance.state) && instance.health === "unhealthy")) {
        return "unhealthy";
    }
    return "";
}

export function countContainerIssues(instances: ContainerState[]): number {
    return instances.filter(instance => containerIssue(instance)).length;
}
