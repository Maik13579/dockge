import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { sync as commandExistsSync } from "command-exists";
import { log } from "./log";

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();
    protected static shutdowns: Set<string> = new Set();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;
    protected operationName: string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callbacks : Array<(exitCode : number) => void> = [];
    protected exitCode? : number;
    protected interrupted = false;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string, operationName = name) {
        this.server = server;
        this._name = name;
        this.operationName = operationName;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.operationName, this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            this._ptyProcess = pty.spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: TERMINAL_COLS,
                rows: this.rows,
            });

            // On Data
            this._ptyProcess.onData((data) => {
                this.buffer.pushItem(data);

                for (const socketID in this.socketList) {
                    const socket = this.socketList[socketID];
                    socket.emitAgent("terminalWrite", this.name, data);
                }
            });

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);
                const exitCode = Number(error.message.split(" ").pop());
                this.exit({
                    exitCode,
                });
            }
        }
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        if (this.exitCode !== undefined) {
            return;
        }
        this.exitCode = res.exitCode;
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        if (Terminal.getTerminal(this.operationName) === this) {
            Terminal.terminalMap.delete(this.operationName);
        }
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        for (const callback of this.callbacks) {
            callback(res.exitCode);
        }
        this.callbacks = [];
    };

    public onExit(callback : (exitCode : number) => void) {
        if (this.exitCode !== undefined) {
            callback(this.exitCode);
        } else {
            this.callbacks.push(callback);
        }
    }

    public join(socket : DockgeSocket) {
        this.socketList[socket.id] = socket;
    }

    public leave(socket : DockgeSocket) {
        delete this.socketList[socket.id];
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    close() {
        clearInterval(this.keepAliveInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
    }

    /** Stop a pending Compose command before starting its replacement. */
    public interrupt(): Promise<void> {
        if (this.exitCode !== undefined) {
            return Promise.resolve();
        }
        this.interrupted = true;
        return new Promise((resolve, reject) => {
            // Give Compose a chance to exit on Ctrl+C, then stop the CLI process
            // so a waiting up cannot keep creating containers during down.
            const killTimer = setTimeout(() => this.ptyProcess?.kill("SIGKILL"), 2000);
            const timeout = setTimeout(() => reject(new Error("The previous Compose command did not exit.")), 5000);
            this.onExit(() => {
                clearTimeout(killTimer);
                clearTimeout(timeout);
                resolve();
            });
            this.close();
        });
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    /** Commands can run independently while sharing one progress display. */
    public static getTerminals(name: string): Terminal[] {
        return [ ...Terminal.terminalMap.values() ].filter(terminal => terminal.name === name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static async exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string, interrupt = false, operationName = terminalName) : Promise<number> {
        if (Terminal.shutdowns.has(terminalName)) {
            throw new Error("The stack is stopping, please wait for it to finish.");
        }
        if (interrupt) {
            // Keep the group locked across process exits and the following
            // shutdown command, including while awaiting multiple children.
            Terminal.shutdowns.add(terminalName);
        }
        try {
            if (interrupt) {
                await Promise.all(Terminal.getTerminals(terminalName).map(terminal => terminal.interrupt()));
            }
            return await new Promise<number>((resolve, reject) => {
                const running = Terminal.getTerminals(terminalName);
                if (Terminal.terminalMap.has(operationName)
                    || (operationName === terminalName && running.length > 0)
                    || running.some(terminal => terminal.interrupted)) {
                    reject(new Error("Another operation is already running, please try again later."));
                    return;
                }

                let terminal = new Terminal(server, terminalName, file, args, cwd, operationName);
                terminal.rows = PROGRESS_TERMINAL_ROWS;

                if (socket) {
                    terminal.join(socket);
                }

                terminal.onExit((exitCode : number) => {
                    if (terminal.interrupted) {
                        reject(new Error("Compose operation cancelled by Stop."));
                    } else {
                        resolve(exitCode);
                    }
                });
                terminal.start();
            });
        } finally {
            if (interrupt) {
                Terminal.shutdowns.delete(terminalName);
            }
        }
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    constructor(server : DockgeServer, name : string) {
        let shell;

        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir);
    }

    public write(input : string) {
        super.write(input);
    }
}
