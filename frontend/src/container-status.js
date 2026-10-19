/** Group errors/restarts, running containers, exited containers, then inactive services. */
export function containerStatusGroup(instances = []) {
    if (instances.some(instance => instance.health === "unhealthy"
        || [ "error", "dead", "unhealthy", "restarting" ].includes(instance.state || instance.status)
        || (instance.state === "exited" && typeof instance.exitCode === "number" && instance.exitCode !== 0))) {
        return 0;
    }
    if (instances.some(instance => [ "running", "paused", "healthy", "starting" ].includes(instance.state || instance.status))) {
        return 1;
    }
    if (instances.some(instance => instance.state === "exited" || instance.status === "exited")) {
        return 2;
    }
    return 3;
}
