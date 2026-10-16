import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveComposeConfig } from "../backend/compose-config";

test("config previews isolate drafts, preserve path context and clean up after failures", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-config-test-"));
    const previousPath = process.env.PATH;
    const previousDirectory = process.env.DOCKGE_CONFIG_TEST_DIR;
    t.after(async () => {
        process.env.PATH = previousPath;
        if (previousDirectory === undefined) {
            delete process.env.DOCKGE_CONFIG_TEST_DIR;
        } else {
            process.env.DOCKGE_CONFIG_TEST_DIR = previousDirectory;
        }
        await fs.rm(directory, { recursive: true,
            force: true });
    });
    const projectDirectory = path.join(directory, "stack");
    await fs.mkdir(projectDirectory);
    const savedCompose = path.join(projectDirectory, "compose.yaml");
    await fs.writeFile(savedCompose, "# saved file must stay untouched\n");
    const globalEnvFile = path.join(directory, "global.env");
    await fs.writeFile(globalEnvFile, "GLOBAL=value\n");

    // Inspect the subprocess boundary without contacting Docker or its daemon.
    await fs.writeFile(path.join(directory, "docker"), `#!/bin/sh
printf '%s\\n' "$@" > "$DOCKGE_CONFIG_TEST_DIR/args"
pwd > "$DOCKGE_CONFIG_TEST_DIR/cwd"
: > "$DOCKGE_CONFIG_TEST_DIR/files"
next_file=false
index=0
for arg in "$@"; do
    if [ "$next_file" = true ]; then
        printf '%s\\n' "$arg" >> "$DOCKGE_CONFIG_TEST_DIR/files"
        cat "$arg" > "$DOCKGE_CONFIG_TEST_DIR/input-$index"
        index=$((index + 1))
    fi
    case "$arg" in
        -f|--env-file) next_file=true ;;
        *) next_file=false ;;
    esac
done
case "$(cat "$DOCKGE_CONFIG_TEST_DIR/stack/compose.yaml")" in
    *fail*) printf 'Invalid included Compose file' >&2; exit 1 ;;
esac
printf '%s' '{"services":{"included":{"image":"example/api:2"}}}'
`, { mode: 0o700 });
    process.env.PATH = directory + path.delimiter + previousPath;
    process.env.DOCKGE_CONFIG_TEST_DIR = directory;

    const readTrace = async () => {
        const args = (await fs.readFile(path.join(directory, "args"), "utf8")).trim().split("\n");
        const cwd = (await fs.readFile(path.join(directory, "cwd"), "utf8")).trim();
        const files = (await fs.readFile(path.join(directory, "files"), "utf8")).trim().split("\n");
        const contents = await Promise.all(files.map((file: string, index: number) => fs.readFile(path.join(directory, `input-${index}`), "utf8")));
        return { args,
            cwd,
            files,
            contents };
    };

    const draft = {
        projectDirectory,
        workingDirectory: projectDirectory,
        globalEnvFile,
        composeYAML: "include:\n  - ../shared/compose.yaml\n",
        composeOverrideYAML: "services:\n  included:\n    image: example/api:2\n",
        composeENV: "TAG=2\n",
    };
    assert.deepEqual(await resolveComposeConfig(draft), { services: { included: { image: "example/api:2" } } });
    let trace = await readTrace();
    assert.equal(trace.cwd, projectDirectory);
    assert.deepEqual(trace.args.slice(0, 6), [ "compose", "--project-directory", projectDirectory, "--env-file", globalEnvFile, "--env-file" ]);
    assert.deepEqual(trace.args.slice(-5), [ "--profile", "*", "config", "--format", "json" ]);
    assert.deepEqual(trace.contents, [ "GLOBAL=value\n", draft.composeENV, draft.composeYAML, draft.composeOverrideYAML ]);
    assert.equal(await fs.readFile(savedCompose, "utf8"), "# saved file must stay untouched\n");
    for (const file of trace.files.slice(1)) {
        await assert.rejects(fs.access(file));
    }

    // Empty overrides are omitted; errors still remove all draft files.
    await fs.writeFile(savedCompose, "# fail\n");
    await assert.rejects(resolveComposeConfig({ ...draft,
        composeOverrideYAML: "" }), /Invalid included Compose file/);
    trace = await readTrace();
    assert.equal(trace.args.filter((arg: string) => arg === "-f").length, 1);
    for (const file of trace.files.slice(1)) {
        await assert.rejects(fs.access(file));
    }
});
