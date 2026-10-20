import { containerIssue, countContainerIssues } from "../../common/container-status";

export { containerIssue, countContainerIssues };

/** Group errors/restarts, running containers, exited containers, then inactive services. */
export function containerStatusGroup(instances = []) {
    if (instances.some(instance => containerIssue(instance))) {
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
