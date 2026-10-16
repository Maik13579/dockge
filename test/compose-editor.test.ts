import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { editableService, updateOverride } from "../frontend/src/compose-editor.js";

test("included services adapt canonical values without changing the resolved model", () => {
    const config = {
        image: "example/api:1",
        ports: [{ target: 80,
            published: "8080",
            protocol: "tcp",
            mode: "ingress" }],
        volumes: [{ type: "bind",
            source: "/opt/shared",
            target: "/data",
            read_only: true,
            bind: { create_host_path: true } }],
        environment: { MODE: "development",
            INHERITED: null },
        networks: { shared: null },
        depends_on: { database: { condition: "service_started",
            required: true } },
    };
    const snapshot = JSON.stringify(config);
    assert.deepEqual(editableService(config), {
        image: "example/api:1",
        ports: [ "8080:80/tcp" ],
        volumes: [ "/opt/shared:/data:ro" ],
        environment: [ "MODE=development", "INHERITED" ],
        networks: [ "shared" ],
        depends_on: [ "database" ],
    });
    assert.equal(JSON.stringify(config), snapshot);
});

test("advanced options remain in long syntax instead of silently losing settings", () => {
    const config = {
        ports: [{ target: 80,
            published: "8080",
            app_protocol: "http" }],
        volumes: [{ type: "volume",
            source: "data",
            target: "/data",
            volume: { nocopy: true } }],
        networks: { shared: { aliases: [ "api" ] } },
        depends_on: { database: { condition: "service_healthy",
            required: true } },
    };
    assert.deepEqual(editableService(config), config);
});

test("editing an included image writes only that field to overrides", () => {
    const source = "# Local settings\nservices:\n  other:\n    restart: always # keep this\n";
    const result = updateOverride(source, "included-api", "image", "example/api:2");
    assert.match(result, /# Local settings/);
    assert.match(result, /# keep this/);
    assert.deepEqual(parseDocument(result).toJS(), {
        services: {
            other: { restart: "always" },
            "included-api": { image: "example/api:2" },
        },
    });
});

test("list edits replace inherited entries, including clearing the entire list", () => {
    let source = updateOverride("", "included-api", "ports", [ "9090:80" ]);
    assert.match(source, /ports: !override/);
    source = updateOverride(source, "included-api", "ports", []);
    assert.match(source, /ports: !override \[\]/);
    const doc = parseDocument(source, { logLevel: "silent" });
    assert.deepEqual(doc.toJS(), { services: { "included-api": { ports: [] } } });
});

test("editing another field preserves existing Compose tags and expressions", () => {
    const source = "services:\n  api:\n    image: example/api:${TAG}\n    ports: !override [9090:80]\n    environment:\n      REMOVED: !reset null\n";
    const result = updateOverride(source, "api", "restart", "always");
    assert.match(result, /image: example\/api:\$\{TAG\}/);
    assert.match(result, /ports: !override/);
    assert.match(result, /REMOVED: !reset null/);
});

test("invalid overrides are rejected instead of overwritten", () => {
    assert.throws(() => updateOverride("services: [", "api", "image", "example/api:2"));
});
