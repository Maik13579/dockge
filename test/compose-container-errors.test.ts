import assert from "node:assert/strict";
import { test } from "node:test";
import childProcessAsync from "promisify-child-process";
import { containerIssue, countContainerIssues } from "../common/container-status";
import { getProjectErrorCounts } from "../backend/container-errors";

test("failure detection includes crashes, restart loops, unhealthy and dead containers", () => {
    for (const instance of [
        { state: "exited",
            exitCode: 137 },
        { state: "restarting" },
        { state: "dead" },
        { state: "error" },
        { state: "running",
            health: "unhealthy" },
        { status: "unhealthy" },
    ]) {
        assert.ok(containerIssue(instance), JSON.stringify(instance));
    }
    assert.equal(countContainerIssues([
        { state: "running" },
        { state: "exited",
            exitCode: 1 },
        { state: "running",
            health: "unhealthy" },
    ]), 2);
});

test("successful jobs, stopped containers and pending health checks are not errors", () => {
    for (const instance of [
        { state: "running",
            health: "healthy" },
        { state: "running",
            health: "starting" },
        { state: "exited",
            exitCode: 0 },
        { state: "exited" },
        { state: "exited",
            health: "unhealthy",
            exitCode: 0 },
        { state: "created" },
        { state: "paused" },
    ]) {
        assert.equal(containerIssue(instance), "", JSON.stringify(instance));
    }
});

test("device status inspects all Compose containers in one batch and groups errors by project", async t => {
    const rows = [
        { project: "robot",
            state: "running",
            health: "healthy",
            exitCode: 0 },
        { project: "robot",
            state: "exited",
            health: "",
            exitCode: 137 },
        { project: "robot",
            state: "restarting",
            health: "",
            exitCode: 1 },
        { project: "vision",
            state: "running",
            health: "unhealthy",
            exitCode: 0 },
        { project: "job",
            state: "exited",
            health: "",
            exitCode: 0 },
    ];
    const ids = rows.map((_, index) => (index + 1).toString(16).padStart(12, "0"));
    const execution = t.mock.method(childProcessAsync, "spawn", async (_command, args) => ({
        stdout: args[0] === "ps" ? ids.join("\n") : rows.map(row => JSON.stringify(row)).join("\n"),
    }) as Awaited<ReturnType<typeof childProcessAsync.spawn>>);
    assert.deepEqual(await getProjectErrorCounts(), new Map([[ "robot", 2 ], [ "vision", 1 ]]));
    assert.equal(execution.mock.calls.length, 2);
    assert.deepEqual(execution.mock.calls[0].arguments[1], [ "ps", "--all", "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}" ]);
    const inspection = execution.mock.calls[1].arguments[1];
    assert.deepEqual(inspection.slice(0, 4), [ "inspect", "--type", "container", "--format" ]);
    assert.deepEqual(inspection.slice(5), ids);
    assert.match(inspection[4], /\.State.ExitCode/);
    assert.match(inspection[4], /com.docker.compose.project/);
    assert.equal(execution.mock.calls[1].arguments[2]?.timeout, 10000);
});

test("empty Docker devices need no inspection and incomplete results are rejected", async t => {
    let output = "";
    const execution = t.mock.method(childProcessAsync, "spawn", async () => ({ stdout: output }) as Awaited<ReturnType<typeof childProcessAsync.spawn>>);
    assert.deepEqual(await getProjectErrorCounts(), new Map());
    assert.equal(execution.mock.calls.length, 1);
    output = "not-a-container-id";
    await assert.rejects(getProjectErrorCounts(), /Invalid Docker container ID/);
    execution.mock.mockImplementation(async (_command, args) => ({ stdout: args[0] === "ps" ? "123456789abc" : "" }) as Awaited<ReturnType<typeof childProcessAsync.spawn>>);
    await assert.rejects(getProjectErrorCounts(), /Incomplete Docker/);
});
