import { stackGroupEndpoint } from "../../common/stack-groups";
import { containerStatusGroup } from "./container-status";
import { getCombinedTerminalName, getComposeTerminalName } from "../../common/util-common";

let nextRequestId = 0;

export default {
    data() {
        return {
            owner: this.$route.params.endpoint || "",
            name: this.$route.params.groupName || "",
            members: [],
            selected: [],
            choices: [],
            choiceSearch: "",
            error: "",
            optionsError: "",
            optionsRequest: 0,
            editing: !this.$route.params.groupName,
            loading: false,
            saving: false,
            processing: false,
            stopping: false,
            operation: 0,
            serviceOperations: {},
            serviceOperationRequest: 0,
            results: [],
            compactView: localStorage.containerView === "compact",
            terminalMember: "",
            snapshotTimer: null,
            snapshotRequest: 0,
            disposed: false,
            originalMembers: [],
            originalName: "",
        };
    },
    computed: {
        isAdd() {
            return !this.$route.params.groupName;
        },
        dirty() {
            return this.name !== this.originalName || JSON.stringify(this.selected) !== JSON.stringify(this.originalMembers);
        },
        groupRoute() {
            return `/stack-group/${encodeURIComponent(this.name)}${this.owner ? "/" + encodeURIComponent(this.owner) : ""}`;
        },
        rows() {
            return this.members.flatMap(member => Object.keys(member.config?.services || {}).map(name => ({
                key: JSON.stringify([ member.reference, name ]),
                name,
                member,
            }))).sort((a, b) => containerStatusGroup(a.member.serviceStatusList?.[a.name]) - containerStatusGroup(b.member.serviceStatusList?.[b.name])
                || a.name.localeCompare(b.name, undefined, { numeric: true }) || a.member.reference.localeCompare(b.member.reference));
        },
        selectedMember() {
            return this.members.find(member => member.reference === this.terminalMember && member.stack);
        },
        terminalEndpoint() {
            return this.selectedMember ? this.memberEndpoint(this.selectedMember) : "";
        },
        combinedTerminalName() {
            return getCombinedTerminalName(this.terminalEndpoint, this.selectedMember?.stackName || "");
        },
        progressTerminalName() {
            return getComposeTerminalName(this.terminalEndpoint, this.selectedMember?.stackName || "");
        },
        missingSelections() {
            const available = new Set(this.choices.flatMap(choice => choice.stacks.map(stack => stack.reference)));
            return this.selected.filter(reference => !available.has(reference));
        },
        groupState() {
            if (!this.members.length) {
                return "No stacks selected";
            }
            if (this.members.some(member => member.error)) {
                return "Members unavailable";
            }
            const running = this.members.filter(member => Object.values(member.serviceStatusList || {}).some(instances => instances.some(instance => [ "running", "restarting", "paused" ].includes(instance.state))));
            return running.length === this.members.length ? "Running" : running.length ? "Partially running" : "Stopped";
        },
    },
    watch: {
        owner() {
            if (this.isAdd) {
                this.selected = [];
                this.choices = [];
                this.loadOptions();
            }
        },
        "$root.socketIO.authenticatedConnectCount"() {
            if (!this.isAdd) {
                this.refresh();
            }
        },
    },
    mounted() {
        this.$root.stackListMode = "groups";
        if (this.isAdd) {
            this.loadOptions();
        } else {
            this.load();
        }
    },
    beforeUnmount() {
        this.disposed = true;
        this.snapshotRequest++;
        clearTimeout(this.snapshotTimer);
        for (const member of this.members) {
            this.$root.emitAgent(this.memberEndpoint(member), "leaveCombinedTerminal", member.stackName, () => {});
        }
    },
    beforeRouteLeave(to, from, next) {
        next(!this.editing || !this.dirty || window.confirm(this.$t("confirmLeaveStack")));
    },
    methods: {
        request(payload, timeout = 50000, onProgress) {
            const owner = this.owner;
            const socket = this.$root.getSocket();
            const requestId = `${Date.now()}-${++nextRequestId}`;
            if (!this.$root.socketIO.connected || (owner && this.$root.agentStatusList[owner] === "offline")) {
                return Promise.reject(new Error(this.$t("Selected device is offline")));
            }
            return new Promise((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    socket.off("disconnect", disconnected);
                    socket.off("agentStatus", agentStatus);
                    socket.off("agent", progress);
                };
                const fail = (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    cleanup();
                    reject(error);
                };
                const disconnected = () => fail(new Error(this.$t("Lost connection to the socket server. Reconnecting...")));
                const agentStatus = status => {
                    if (status.endpoint === owner && status.status === "offline") {
                        fail(new Error(this.$t("Selected device is offline")));
                    }
                };
                const progress = (event, update) => {
                    if (!settled && event === "stackGroupProgress" && update?.requestId === requestId && (update.endpoint || "") === owner) {
                        onProgress?.(update);
                    }
                };
                const timer = timeout ? setTimeout(() => fail(new Error(this.$t("Stack group request timed out"))), timeout) : null;
                socket.on("disconnect", disconnected);
                socket.on("agentStatus", agentStatus);
                if (onProgress) {
                    socket.on("agent", progress);
                }
                this.$root.emitAgent(owner, "stackGroupRequest", { ...payload,
                    ...(onProgress ? { requestId } : {}) }, result => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    cleanup();
                    resolve(result);
                });
            });
        },
        memberEndpoint(member) {
            return stackGroupEndpoint(this.owner, this.name, member.reference);
        },
        containerContext(row) {
            return {
                endpoint: this.memberEndpoint(row.member),
                stack: row.member.stack,
                serviceConfig: row.member.config,
                displayEnvConfig: row.member.config,
                stopping: this.stopping,
                processing: !!row.member.error || !row.member.stack?.isManagedByDockge,
                operationRunning: false,
                serviceOperations: { [row.name]: this.serviceOperations[row.key] },
            };
        },
        setContainerView(compact) {
            this.compactView = compact;
            localStorage.containerView = compact ? "compact" : "cards";
        },
        async load() {
            this.loading = true;
            try {
                const result = await this.request({ action: "get",
                    name: this.name });
                if (!result.ok) {
                    throw new Error(result.msg);
                }
                if (this.disposed) {
                    return;
                }
                this.updateMembers(result.members.map(member => ({ ...this.members.find(previous => previous.reference === member.reference),
                    ...member })), true);
                this.selected = result.members.map(member => member.reference);
                this.originalMembers = [ ...this.selected ];
                this.originalName = this.name;
                this.error = "";
                this.refresh();
            } catch (error) {
                if (!this.disposed) {
                    this.error = error.message;
                }
            } finally {
                this.loading = false;
            }
        },
        refresh() {
            this.requestSnapshot(true);
        },
        updateMembers(members, replace = false) {
            const previous = new Map(this.members.map(member => [ member.reference, member ]));
            const updated = members.map(member => member.error ? { ...previous.get(member.reference),
                ...member } : member);
            const combined = replace ? new Map() : previous;
            for (const member of updated) {
                combined.set(member.reference, member);
            }
            this.members = [ ...combined.values() ];
            if (!this.members.some(member => member.reference === this.terminalMember && member.stack)) {
                this.terminalMember = this.members.find(member => member.stack)?.reference || "";
            }
        },
        async requestSnapshot(refresh = false) {
            clearTimeout(this.snapshotTimer);
            if (this.disposed || this.isAdd) {
                return;
            }
            const request = ++this.snapshotRequest;
            try {
                const result = await this.request({ action: "snapshot",
                    name: this.originalName || this.name,
                    refresh }, 50000, update => {
                    if (request === this.snapshotRequest && !this.disposed && update.member) {
                        this.updateMembers([ update.member ]);
                        this.error = "";
                    }
                });
                if (request !== this.snapshotRequest || this.disposed) {
                    return;
                }
                if (!result.ok) {
                    throw new Error(result.msg);
                }
                this.updateMembers(result.members, true);
                this.error = "";
            } catch (error) {
                if (request === this.snapshotRequest && !this.disposed) {
                    this.error = error.message;
                }
            } finally {
                if (request === this.snapshotRequest && !this.disposed) {
                    this.snapshotTimer = setTimeout(() => this.requestSnapshot(), 5000);
                }
            }
        },
        async loadOptions() {
            const owner = this.owner;
            const request = ++this.optionsRequest;
            const mergeChoice = choice => choice.error ? { ...choice,
                stacks: this.choices.find(previous => previous.endpoint === choice.endpoint)?.stacks || [] } : choice;
            this.optionsError = "";
            try {
                const result = await this.request({ action: "options" }, 50000, update => {
                    if (request !== this.optionsRequest || owner !== this.owner || this.disposed || !update.choice) {
                        return;
                    }
                    const choice = mergeChoice(update.choice);
                    const index = this.choices.findIndex(previous => previous.endpoint === choice.endpoint);
                    if (index < 0) {
                        this.choices.push(choice);
                    } else {
                        this.choices.splice(index, 1, choice);
                    }
                });
                if (request !== this.optionsRequest || owner !== this.owner || this.disposed) {
                    return;
                }
                if (!result.ok) {
                    throw new Error(result.msg);
                }
                this.choices = result.choices.map(mergeChoice);
            } catch (error) {
                if (request === this.optionsRequest && owner === this.owner && !this.disposed) {
                    this.optionsError = error.message;
                }
            }
        },
        edit() {
            this.editing = true;
            this.load();
            this.loadOptions();
        },
        async save() {
            this.saving = true;
            try {
                const result = await this.request({ action: "save",
                    name: this.name,
                    members: this.selected,
                    ...(this.isAdd ? {} : { original: this.originalName }) });
                if (!result.ok) {
                    throw new Error(result.msg);
                }
                this.editing = false;
                this.originalName = this.name;
                this.originalMembers = [ ...this.selected ];
                if (this.$route.path !== this.groupRoute) {
                    this.$router.push(this.groupRoute);
                } else {
                    this.load();
                }
            } catch (error) {
                this.error = error.message;
            } finally {
                this.saving = false;
            }
        },
        discard() {
            if (this.isAdd) {
                this.editing = false;
                this.$router.push("/");
                return;
            }
            this.name = this.originalName;
            this.selected = [ ...this.originalMembers ];
            this.editing = false;
        },
        async remove() {
            if (!window.confirm(this.$t("Delete this group? Member stacks are kept."))) {
                return;
            }
            const result = await this.request({ action: "delete",
                name: this.originalName });
            if (result.ok) {
                this.editing = false;
                this.$router.push("/");
            } else {
                this.error = result.msg;
            }
        },
        async runGroupOperation(event) {
            if (this.stopping) {
                return;
            }
            const request = ++this.operation;
            this.processing = true;
            this.stopping = [ "stopStack", "downStack", "killStack" ].includes(event);
            this.results = [];
            this.error = "";
            try {
                const result = await this.request({ action: "operate",
                    name: this.name,
                    event }, 0);
                if (request !== this.operation || this.disposed) {
                    return;
                }
                this.results = result.results || [];
                if (!result.ok) {
                    this.error = result.msg;
                }
            } catch (error) {
                if (request === this.operation) {
                    this.error = error.message;
                }
            } finally {
                if (request === this.operation) {
                    this.processing = false;
                    this.stopping = false;
                    this.requestSnapshot();
                }
            }
        },
        async runServiceOperation(event, row) {
            if (this.stopping || this.serviceOperations[row.key]) {
                return;
            }
            const operation = ++this.serviceOperationRequest;
            this.serviceOperations[row.key] = operation;
            try {
                const result = await this.request({ action: "proxy",
                    name: this.name,
                    member: row.member.reference,
                    event,
                    args: [ row.member.stackName, row.name ] }, 0);
                if (this.serviceOperations[row.key] !== operation || this.disposed) {
                    return;
                }
                this.$root.toastRes(result);
            } catch (error) {
                if (!this.disposed) {
                    this.error = error.message;
                }
            } finally {
                if (this.serviceOperations[row.key] === operation) {
                    delete this.serviceOperations[row.key];
                    this.requestSnapshot();
                }
            }
        },
        matchesChoice(choice, stack) {
            return `${choice.agentName} ${stack.name}`.toLowerCase().includes(this.choiceSearch.toLowerCase());
        },
    },
};
