import { agentRequest } from "./agent-request";
export default {
    data() {
        return { show: false,
            scope: "managed",
            remove: false,
            selected: [],
            previews: {},
            jobs: {},
            errors: {},
            busy: false,
            version: 0,
            timer: null,
            disposed: false };
    },
    computed: {
        storageKey() {
            return "dockgeBulkJobs:" + (this.$root.username || "");
        },
        devices() {
            return Object.keys({ "": {},
                ...this.$root.agentList }).filter(endpoint => this.online(endpoint) || this.selected.includes(endpoint) || this.jobs[endpoint])
                .map(endpoint => ({ endpoint,
                    name: this.$root.endpointDisplayFunction(endpoint),
                    online: this.online(endpoint),
                    supported: this.supported(endpoint) }));
        },
        running() {
            return Object.values(this.jobs).some(job => job.state === "running");
        },
        canRun() {
            return !this.busy && !this.running && this.selected.length > 0 && this.selected.some(endpoint => this.online(endpoint) && this.supported(endpoint) && this.previews[endpoint]?.token && !this.errors[endpoint]);
        },
    },
    watch: {
        scope() {
            this.refreshPreviews();
        },
        remove() {
            this.refreshPreviews();
        },
        selected: { deep: true,
            handler() {
                this.refreshPreviews();
            } },
    },
    mounted() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.storageKey) || "{}");
            for (const [ endpoint, job ] of Object.entries(saved)) {
                if (typeof job.id === "string" && [ "running", "completed", "failed" ].includes(job.state)) {
                    this.jobs[endpoint] = job;
                }
            }
        } catch { /* Ignore corrupt browser preferences. */ }
        if (this.running) {
            this.poll();
        }
    },
    beforeUnmount() {
        this.disposed = true;
        this.version++;
        clearTimeout(this.timer);
    },
    methods: {
        online(endpoint) {
            return this.$root.socketIO.connected && (!endpoint || this.$root.agentStatusList[endpoint] === "online");
        },
        supported(endpoint) {
            return endpoint ? this.$root.containerCapabilities?.[endpoint] === true : this.$root.info?.containerManagement === true;
        },
        request(endpoint, input) {
            return agentRequest(this.$root, endpoint, "bulkContainerAction", input);
        },
        saveJobs() {
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(this.jobs));
            } catch { /* Storage availability must not prevent explicit container actions. */ }
        },
        open() {
            this.show = true;
            if (!this.running) {
                this.refreshPreviews();
            }
        },
        selectAll() {
            this.selected = this.devices.filter(device => device.online && device.supported).map(device => device.endpoint);
        },
        async refreshPreviews() {
            if (this.running || this.busy) {
                return;
            }
            const version = ++this.version;
            this.previews = {};
            this.errors = {};
            await Promise.all(this.selected.map(async (endpoint) => {
                try {
                    if (!this.supported(endpoint)) {
                        throw new Error("Update agent");
                    }
                    const result = await this.request(endpoint, { action: "preview",
                        options: { scope: this.scope,
                            remove: this.remove } });
                    if (version === this.version && !this.disposed) {
                        this.previews[endpoint] = result.preview;
                    }
                } catch (error) {
                    if (version === this.version && !this.disposed) {
                        this.errors[endpoint] = error.message;
                    }
                }
            }));
        },
        async execute() {
            if (!this.canRun) {
                return;
            }
            const ready = this.selected.filter(endpoint => this.online(endpoint) && this.supported(endpoint) && this.previews[endpoint]?.token && !this.errors[endpoint]);
            for (const endpoint of this.selected.filter(endpoint => !ready.includes(endpoint))) {
                this.errors[endpoint] ||= this.online(endpoint) ? "Preview unavailable; refresh and try again" : "Selected device is offline";
            }
            if (ready.some(endpoint => this.previews[endpoint].expires <= Date.now())) {
                await this.refreshPreviews();
                return;
            }
            this.busy = true;
            const selected = ready;
            // Save IDs before sending: a lost acknowledgement must not hide an operation that started.
            for (const endpoint of selected) {
                this.jobs[endpoint] = { id: this.previews[endpoint].token,
                    state: "running",
                    total: this.previews[endpoint].count,
                    completed: 0,
                    results: [] };
            }
            this.saveJobs();
            await Promise.all(selected.map(async (endpoint) => {
                try {
                    const result = await this.request(endpoint, { action: "execute",
                        token: this.jobs[endpoint].id });
                    this.jobs[endpoint] = result.job;
                    delete this.errors[endpoint];
                } catch (error) {
                    this.errors[endpoint] = error.message;
                    if (!error.transport) {
                        this.jobs[endpoint].state = "failed";
                    }
                }
                this.saveJobs();
            }));
            this.busy = false;
            this.previews = {};
            this.poll();
        },
        async poll() {
            clearTimeout(this.timer);
            if (this.disposed) {
                return;
            }
            await Promise.all(Object.entries(this.jobs).filter(([ endpoint, job ]) => job.state === "running" && this.online(endpoint) && this.supported(endpoint)).map(async ([ endpoint, job ]) => {
                try {
                    const result = await this.request(endpoint, { action: "status",
                        token: job.id });
                    if (!this.disposed && this.jobs[endpoint]?.id === job.id) {
                        this.jobs[endpoint] = result.job;
                        delete this.errors[endpoint];
                    }
                } catch (error) {
                    if (!this.disposed) {
                        this.errors[endpoint] = error.message;
                        if (!error.transport) {
                            this.jobs[endpoint].state = "failed";
                        }
                    }
                }
            }));
            if (!this.disposed) {
                this.saveJobs();
                if (this.running) {
                    this.timer = setTimeout(() => this.poll(), 1000);
                }
            }
        },
        clearFinished() {
            for (const [ endpoint, job ] of Object.entries(this.jobs)) {
                if (job.state !== "running") {
                    delete this.jobs[endpoint];
                }
            }
            this.saveJobs();
        },
    },
};
