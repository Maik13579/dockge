import { containerStatusGroup } from "./container-status";

export function containerPreferences(storage = {}) {
    return {
        containerColumns: [ 1, 2, 3, 4 ].includes(Number(storage.containerColumns)) ? Number(storage.containerColumns) : 1,
        containerSort: [ "status", "name", "cpu", "memory" ].includes(storage.containerSort) ? storage.containerSort : "status",
        containerDirection: storage.containerDirection === "desc" ? "desc" : "asc",
    };
}

export function memoryBytes(value) {
    const match = String(value || "").trim().match(/^([\d.]+)\s*(B|[KMGTPE]i?B)\b/i);
    if (!match) {
        return null;
    }
    const unit = match[2].toUpperCase();
    return Number(match[1]) * (unit.includes("I") ? 1024 : 1000) ** Math.max(0, "BKMGTPE".indexOf(unit[0]));
}

export function serviceMetrics(instances = [], stats = {}) {
    const samples = instances.map(instance => stats?.[instance.name]).filter(Boolean);
    const cpu = samples.map(sample => parseFloat(sample.CPUPerc)).filter(Number.isFinite);
    const memory = samples.map(sample => memoryBytes(sample.MemUsage)).filter(value => value !== null && Number.isFinite(value));
    return { cpu: cpu.length ? cpu.reduce((sum, value) => sum + value, 0) : null,
        memory: memory.length ? memory.reduce((sum, value) => sum + value, 0) : null };
}

export function compareContainers(a, b, strategy = "status", direction = "asc") {
    const left = containerStatusGroup(a.instances);
    const right = containerStatusGroup(b.instances);
    const errorOrder = Number(left !== 0) - Number(right !== 0);
    if (errorOrder) {
        return errorOrder;
    }
    let order = 0;
    const multiplier = direction === "desc" ? -1 : 1;
    if (strategy === "status") {
        order = (left - right) * multiplier;
    } else if (strategy === "name") {
        order = a.name.localeCompare(b.name, undefined, { numeric: true }) * multiplier;
    } else {
        const first = serviceMetrics(a.instances, a.stats)[strategy];
        const second = serviceMetrics(b.instances, b.stats)[strategy];
        if (first === null || second === null) {
            order = Number(first === null) - Number(second === null);
        } else {
            order = (first - second) * multiplier;
        }
    }
    return order || a.name.localeCompare(b.name, undefined, { numeric: true }) || String(a.key || "").localeCompare(String(b.key || ""));
}
