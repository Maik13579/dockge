import childProcessAsync from "promisify-child-process";
import { containerIssue } from "../common/container-status";

/** Inspect Compose containers once per device, including stacks which are not open in the UI. */
export async function getProjectErrorCounts(): Promise<Map<string, number>> {
    const options = { encoding: "utf-8" as const,
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024 };
    const listed = await childProcessAsync.spawn("docker", [ "ps", "--all", "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}" ], options);
    const ids = listed.stdout?.toString().trim().split(/\s+/).filter(Boolean) || [];
    const errors = new Map<string, number>();
    if (!ids.length) {
        return errors;
    }
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) {
        throw new Error("Invalid Docker container ID in status response");
    }
    // Use structured state rather than parsing the human-readable Docker status text.
    const format = "{\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"state\":{{json .State.Status}},\"exitCode\":{{json .State.ExitCode}},\"health\":{{if .State.Health}}{{json .State.Health.Status}}{{else}}\"\"{{end}}}";
    const inspected = await childProcessAsync.spawn("docker", [ "inspect", "--type", "container", "--format", format, ...ids ], options);
    const rows = inspected.stdout?.toString().trim().split("\n").filter(Boolean) || [];
    if (rows.length !== ids.length) {
        throw new Error("Incomplete Docker container status response");
    }
    for (const line of rows) {
        const container = JSON.parse(line);
        if (typeof container.project !== "string" || typeof container.state !== "string") {
            throw new Error("Invalid Docker container status response");
        }
        if (containerIssue(container)) {
            errors.set(container.project, (errors.get(container.project) || 0) + 1);
        }
    }
    return errors;
}
