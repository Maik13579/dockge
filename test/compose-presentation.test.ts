import assert from "node:assert/strict";
import { test } from "node:test";
import { compareContainers, containerPreferences, memoryBytes, serviceMetrics } from "../frontend/src/container-presentation.js";
test("column and sorting preferences default safely and restore selected values", () => {
    assert.deepEqual(containerPreferences({}), { containerColumns: 1,
        containerSort: "status",
        containerDirection: "asc" });
    assert.deepEqual(containerPreferences({ containerColumns: "3",
        containerSort: "cpu",
        containerDirection: "desc" }), { containerColumns: 3,
        containerSort: "cpu",
        containerDirection: "desc" });
    assert.equal(containerPreferences({ containerColumns: "999",
        containerSort: "invalid" }).containerColumns, 1);
});
test("resource sorting uses numeric units and totals across replicas", () => {
    assert.equal(memoryBytes("1 GiB / 8 GiB"), 1024 ** 3);
    assert.equal(memoryBytes("1 GB / 8 GB"), 1000 ** 3);
    assert.equal(memoryBytes("512MiB / 1GiB"), 512 * 1024 ** 2);
    assert.equal(memoryBytes("—"), null);
    const instances = [{ name: "a" }, { name: "b" }];
    const stats = { a: { CPUPerc: "9%",
        MemUsage: "512MiB / 1GiB" },
    b: { CPUPerc: "2.5%",
        MemUsage: "512MiB / 1GiB" } };
    assert.deepEqual(serviceMetrics(instances, stats), { cpu: 11.5,
        memory: 1024 ** 3 });
});
test("errors remain pinned for every sorting mode and missing metrics are last", () => {
    const rows = [
        { name: "missing",
            instances: [],
            stats: {} },
        { name: "low",
            instances: [{ name: "low",
                state: "running" }],
            stats: { low: { CPUPerc: "2%",
                MemUsage: "2MiB / 1GiB" } } },
        { name: "high",
            instances: [{ name: "high",
                state: "running" }],
            stats: { high: { CPUPerc: "12%",
                MemUsage: "1GiB / 2GiB" } } },
        { name: "error",
            instances: [{ state: "exited",
                exitCode: 2 }],
            stats: {} },
    ];
    for (const strategy of [ "status", "name", "cpu", "memory" ]) {
        for (const direction of [ "asc", "desc" ]) {
            const sorted = [ ...rows ].sort((a, b) => compareContainers(a, b, strategy, direction));
            assert.equal(sorted[0].name, "error");
        }
    }
    assert.deepEqual([ ...rows ].sort((a, b) => compareContainers(a, b, "cpu", "desc")).map(row => row.name), [ "error", "high", "low", "missing" ]);
    assert.deepEqual([ ...rows ].sort((a, b) => compareContainers(a, b, "memory", "asc")).map(row => row.name), [ "error", "low", "high", "missing" ]);
    assert.equal(rows[0].name, "missing", "Sorting must not mutate source/config order");
});
