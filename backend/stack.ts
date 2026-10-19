import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    getCombinedTerminalName,
    getContainerLogsTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { resolveComposeConfig } from "./compose-config";
import { composeStatus } from "./compose-status";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _composeOverrideYAML?: string;
    protected _composeOverrideFileName: string = "compose.override.yaml";
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();
    protected static pendingUpdates: Map<string, symbol> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false, composeOverrideYAML? : string) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;
        this._composeOverrideYAML = composeOverrideYAML;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
            for (const filename of [ "compose.override.yml", "compose.override.yaml", "docker-compose.override.yml", "docker-compose.override.yaml" ]) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeOverrideFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            composeOverrideYAML: this.composeOverrideYAML,
            composeOverrideFileName: this._composeOverrideFileName,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
            cwd: this.path,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);
        const overrides = yaml.parseDocument(this.composeOverrideYAML);
        if (overrides.errors.length) {
            throw overrides.errors[0];
        }

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    /** Read local overrides separately from the main Compose document. */
    get composeOverrideYAML() : string {
        if (this._composeOverrideYAML === undefined) {
            const filename = path.join(this.path, this._composeOverrideFileName);
            this._composeOverrideYAML = fs.existsSync(filename) ? fs.readFileSync(filename, "utf-8") : "";
        }
        return this._composeOverrideYAML;
    }

    /** Resolve the editor's drafts using the Docker Compose installed on this agent. */
    async resolveConfig() : Promise<object> {
        const globalEnvFile = path.resolve(this.server.stacksDir, "global.env");
        return resolveComposeConfig({
            projectDirectory: this.fullPath,
            workingDirectory: fs.existsSync(this.path) ? this.fullPath : path.resolve(this.server.stacksDir),
            globalEnvFile: fs.existsSync(globalEnvFile) ? globalEnvFile : undefined,
            composeYAML: this.composeYAML,
            composeOverrideYAML: this.composeOverrideYAML,
            composeENV: this.composeENV,
        });
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose.yaml
        fs.writeFileSync(path.join(dir, this._composeFileName), this.composeYAML);
        const overrideFile = path.join(dir, this._composeOverrideFileName);
        if (this.composeOverrideYAML.trim()) {
            fs.writeFileSync(overrideFile, this.composeOverrideYAML);
        } else {
            await fsAsync.rm(overrideFile, { force: true });
        }
        // The config preview and deployment must use the same .env contents.
        const envFile = path.join(dir, ".env");
        if (this.composeENV || fs.existsSync(envFile)) {
            fs.writeFileSync(envFile, this.composeENV);
        }
        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
            for (const filename of [ overrideFile, envFile ]) {
                if (fs.existsSync(filename)) {
                    fs.chownSync(filename, uid, gid);
                }
            }
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async updateStatus() {
        const stacks = await Stack.getStackList(this.server, true);
        this._status = stacks.get(this.name)?.status ?? UNKNOWN;
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = new Map(this.managedStackList);
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from docker compose ls
        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
            timeout: 10000,
            maxBuffer: 10 * 1024 * 1024,
        });

        const composeList = res.stdout ? JSON.parse(res.stdout.toString()) : [];
        // Only clear cached status after a successful poll, so a temporary
        // Docker failure does not make running stacks appear inactive.
        for (const stack of stackList.values()) {
            stack._status = CREATED_FILE;
        }

        for (let composeStack of composeList) {
            // Compose's project name can come from name: or COMPOSE_PROJECT_NAME,
            // independently of the folder name used as Dockge's stack identifier.
            const configFiles: string[] = (composeStack.ConfigFiles || "").split(",").filter(Boolean).map((file: string) => path.resolve(file.trim()));
            let stack = [ ...stackList.values() ].find(candidate => configFiles.includes(path.join(candidate.fullPath, candidate._composeFileName)))
                ?? stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = this.statusConvert(composeStack.Status);
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.statusConvert(composeStack.Status));
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        return composeStatus(status);
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    getComposeOptions(command : string, ...extraOptions : string[]) {
        //--env-file ./../global.env --env-file .env
        let options = [ "compose" ];
        if ([ "up", "down", "stop", "kill", "restart", "pull" ].includes(command)) {
            // The compact TTY renderer hides containers behind "... N more"
            // in the embedded progress terminal. Keep every progress line.
            options.push("--progress", "plain");
        }
        // Let Compose discover its files and honor COMPOSE_FILE as before.
        // Standard override files are loaded automatically by Compose.
        options.push(command, ...extraOptions);
        if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
            if (fs.existsSync(path.join(this.path, ".env"))) {
                options.splice(1, 0, "--env-file", "./.env");
            }
            options.splice(1, 0, "--env-file", "../global.env");
        }
        return options;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        Stack.pendingUpdates.delete(terminalName);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("stop"), this.path, true);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("restart"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        Stack.pendingUpdates.delete(terminalName);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down"), this.path, true);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async kill(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        Stack.pendingUpdates.delete(terminalName);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("kill"), this.path, true);
        if (exitCode !== 0) {
            throw new Error("Failed to kill, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async pull(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        if (Stack.pendingUpdates.has(terminalName)) {
            throw new Error("Another operation is already running, please try again later.");
        }
        const operation = Symbol();
        Stack.pendingUpdates.set(terminalName, operation);
        try {
            let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path);
            if (exitCode !== 0) {
                throw new Error("Failed to pull, please check the terminal output for more information.");
            }

            // Stop also cancels the gap between Pull and Up, where there is no
            // terminal process for Terminal.exec to interrupt.
            await this.updateStatus();
            if (Stack.pendingUpdates.get(terminalName) !== operation) {
                throw new Error("Compose operation cancelled by a shutdown action.");
            }
            log.debug("update", "Status: " + this.status);
            // If the stack is not running, we don't need to restart it
            if (this.status !== RUNNING) {
                return exitCode;
            }

            exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
            if (exitCode !== 0) {
                throw new Error("Failed to restart, please check the terminal output for more information.");
            }
            return exitCode;
        } finally {
            if (Stack.pendingUpdates.get(terminalName) === operation) {
                Stack.pendingUpdates.delete(terminalName);
            }
        }
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "100"), this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    getContainerLogsTerminal(socket: DockgeSocket, serviceName: string) : Terminal {
        if (!/^[a-zA-Z0-9_.-]+$/.test(serviceName)) {
            throw new ValidationError("Invalid service name.");
        }
        const terminalName = getContainerLogsTerminalName(socket.endpoint, this.name, serviceName);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "--follow", "--tail", "100", "--", serviceName), this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        return terminal;
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, Array<object>>();
        const states: string[] = [];

        try {
            let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--all", "--format", "json"), {
                cwd: this.path,
                encoding: "utf-8",
                timeout: 10000,
                maxBuffer: 10 * 1024 * 1024,
            });

            const output = res.stdout?.toString().trim();
            if (!output) {
                this._status = CREATED_FILE;
                return statusList;
            }

            const addLine = (obj: { Service: string, State: string, Name: string, Health: string, ExitCode?: number }) => {
                states.push(obj.State);
                if (!statusList.has(obj.Service)) {
                    statusList.set(obj.Service, []);
                }
                statusList.get(obj.Service)?.push({
                    status: obj.Health || obj.State,
                    state: obj.State,
                    health: obj.Health,
                    name: obj.Name,
                    ...(typeof obj.ExitCode === "number" ? { exitCode: obj.ExitCode } : {}),
                });
            };

            // Compose versions return either a JSON array (possibly pretty
            // printed) or one JSON object per line. Do not silently discard
            // malformed output and report all services as absent.
            let containers;
            try {
                const parsed = JSON.parse(output);
                containers = Array.isArray(parsed) ? parsed : [ parsed ];
            } catch {
                containers = output.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
            }
            for (const container of containers) {
                addLine(container);
            }

            this._status = states.length ? composeStatus(states.join(",")) : CREATED_FILE;
            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            throw e;
        }
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", serviceName), this.path, false, `${terminalName}:service:${serviceName}`);
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("stop", serviceName), this.path, false, `${terminalName}:service:${serviceName}`);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("restart", serviceName), this.path, false, `${terminalName}:service:${serviceName}`);
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async killService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("kill", serviceName), this.path, false, `${terminalName}:service:${serviceName}`);
        if (exitCode !== 0) {
            throw new Error(`Failed to kill service ${serviceName}, please check logs for more information.`);
        }
        return exitCode;
    }

    async pullService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull", serviceName), this.path, false, `${terminalName}:service:${serviceName}`);
        if (exitCode !== 0) {
            throw new Error(`Failed to pull service ${serviceName}, please check logs for more information.`);
        }
        return exitCode;
    }
}
