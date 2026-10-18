import assert from "node:assert/strict";
import { test } from "node:test";
import { composeStatus } from "../backend/compose-status";
import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";

test("running included services take precedence over created or exited containers", () => {
    for (const status of [
        "created(1),running(25)",
        "running(25),created(1)",
        "exited(1), running(25)",
        "created(1),exited(2),running(25)",
    ]) {
        assert.equal(composeStatus(status), RUNNING, status);
    }
});

test("restarting and paused projects remain active", () => {
    for (const status of [ "restarting(1)", "created(1),restarting(2)", "paused(3)" ]) {
        assert.equal(composeStatus(status), RUNNING, status);
    }
});

test("projects without active containers are exited, created or unknown", () => {
    assert.equal(composeStatus("running(25)"), RUNNING);
    assert.equal(composeStatus("exited(25)"), EXITED);
    assert.equal(composeStatus("created(2),exited(1)"), EXITED);
    assert.equal(composeStatus("created(25)"), CREATED_STACK);
    assert.equal(composeStatus("dead(1)"), EXITED);
    assert.equal(composeStatus(""), UNKNOWN);
    assert.equal(composeStatus("unknown(1)"), UNKNOWN);
});
