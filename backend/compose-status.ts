import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";

/** A project remains active while any container is running, restarting or paused. */
export function composeStatus(status: string): number {
    const states = status.split(",").map(value => value.trim().replace(/\(\d+\)$/, ""));
    if (states.some(state => [ "running", "restarting", "paused" ].includes(state))) {
        return RUNNING;
    }
    if (states.includes("exited") || states.includes("dead")) {
        return EXITED;
    }
    if (states.includes("created")) {
        return CREATED_STACK;
    }
    return UNKNOWN;
}
