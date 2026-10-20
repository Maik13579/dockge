import childProcessAsync from "promisify-child-process";
import { containerIssue, DEFAULT_IGNORED_EXIT_CODES } from "../common/container-status";
import type { ContainerState } from "../common/container-status";

/** Inspect Compose containers once per device, including stacks which are not open in the UI. */
export async function getProjectErrorCounts(ignoredExitCodes: number[] = DEFAULT_IGNORED_EXIT_CODES): Promise<Map<string, number>> {
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
    for (const container of await inspectContainerStates(ids)) {
        if (containerIssue(container, ignoredExitCodes)) {
            errors.set(container.project, (errors.get(container.project) || 0) + 1);
        }
    }
    return errors;
}

/** Also used by service snapshots because Compose ps does not report OOMKilled. */
export async function inspectContainerStates(references: string[]): Promise<(ContainerState & { project: string })[]> {
    if (!references.length) {
        return [];
    }
    if (references.some(reference => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(reference))) {
        throw new Error("Invalid Docker container reference");
    }
    const options = { encoding: "utf-8" as const,
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024 };
    // Use structured state rather than parsing the human-readable Docker status text.
    const format = "{\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"state\":{{json .State.Status}},\"exitCode\":{{json .State.ExitCode}},\"oomKilled\":{{json .State.OOMKilled}},\"health\":{{if .State.Health}}{{json .State.Health.Status}}{{else}}\"\"{{end}}}";
    const inspected = await childProcessAsync.spawn("docker", [ "inspect", "--type", "container", "--format", format, ...references ], options);
    const rows = inspected.stdout?.toString().trim().split("\n").filter(Boolean) || [];
    if (rows.length !== references.length) {
        throw new Error("Incomplete Docker container status response");
    }
    return rows.map(line => {
        const container = JSON.parse(line);
        if (typeof container.project !== "string" || typeof container.state !== "string") {
            throw new Error("Invalid Docker container status response");
        }
        return container;
    });
}
