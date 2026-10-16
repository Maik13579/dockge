import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ComposeDraft {
    projectDirectory: string;
    workingDirectory: string;
    globalEnvFile?: string;
    composeYAML: string;
    composeOverrideYAML: string;
    composeENV: string;
}

/** Resolve drafts without overwriting the stack's saved files. */
export async function resolveComposeConfig(draft: ComposeDraft): Promise<object> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-compose-"));
    try {
        const composeFile = path.join(directory, "compose.yaml");
        const overrideFile = path.join(directory, "compose.override.yaml");
        const envFile = path.join(directory, ".env");
        await fs.writeFile(composeFile, draft.composeYAML, { mode: 0o600 });
        await fs.writeFile(envFile, draft.composeENV, { mode: 0o600 });

        // Keep relative includes, bind mounts and env_file paths rooted at the
        // real stack directory, even though the drafts live in a temporary one.
        const args = [ "compose", "--project-directory", draft.projectDirectory ];
        if (draft.globalEnvFile) {
            args.push("--env-file", draft.globalEnvFile);
        }
        args.push("--env-file", envFile, "-f", composeFile);
        if (draft.composeOverrideYAML.trim()) {
            await fs.writeFile(overrideFile, draft.composeOverrideYAML, { mode: 0o600 });
            args.push("-f", overrideFile);
        }
        // Like the source editor, show services in inactive profiles as well.
        args.push("--profile", "*", "config", "--format", "json");

        const { stdout } = await execFileAsync("docker", args, {
            cwd: draft.workingDirectory,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(stdout);
    } finally {
        await fs.rm(directory, { recursive: true,
            force: true });
    }
}
