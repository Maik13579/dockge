import { cancelUpload, imageRequest, uploadArchive } from "./images";

export default {
    data() {
        return {
            endpoint: "",
            images: [],
            expanded: {},
            details: {},
            busy: {},
            search: "",
            hideUntagged: localStorage.hideUntaggedImages !== "false",
            loading: false,
            error: "",
            dragging: false,
            requestVersion: 0,
            disposed: false,
            pullDialog: false,
            tagDialog: false,
            copyDialog: false,
            reference: "",
            tagReference: "",
            selected: null,
            copyDestination: null,
        };
    },
    computed: {
        devices() {
            return Object.keys({ "": {},
                ...this.$root.agentList }).map(endpoint => ({ endpoint,
                name: this.deviceName(endpoint) }));
        },
        supported() {
            return this.endpoint ? this.$root.agentCapabilities[this.endpoint] === true : this.$root.info.imageManagement === true;
        },
        available() {
            return this.online(this.endpoint) && this.supported;
        },
        destinations() {
            return this.devices.filter(device => device.endpoint !== this.endpoint && this.online(device.endpoint)
                && (device.endpoint ? this.$root.agentCapabilities[device.endpoint] : this.$root.info.imageManagement));
        },
        filtered() {
            const search = this.search.toLowerCase();
            return this.images.filter(image => (!this.hideUntagged || image.tags.length > 0)
                && [ image.id, ...image.tags ].some(text => text.toLowerCase().includes(search)))
                .sort((a, b) => (a.tags[0] || a.id).localeCompare(b.tags[0] || b.id, undefined, { numeric: true }));
        },
        jobs() {
            return Object.values(this.$root.imageJobs).slice().reverse();
        },
        finishedJobs() {
            return this.jobs.filter(job => !this.activeJob(job)).map(job => job.id).join(",");
        },
    },
    watch: {
        endpoint() {
            this.images = [];
            this.details = {};
            this.expanded = {};
            this.search = "";
            this.pullDialog = this.tagDialog = this.copyDialog = false;
            this.load();
        },
        available() {
            this.load();
        },
        hideUntagged(value) {
            localStorage.hideUntaggedImages = String(value);
        },
        finishedJobs() {
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    beforeUnmount() {
        this.disposed = true;
        this.requestVersion++;
    },
    methods: {
        deviceName(endpoint) {
            return this.$root.endpointDisplayFunction(endpoint);
        },
        online(endpoint) {
            return this.$root.socketIO.connected && (!endpoint || this.$root.agentStatusList[endpoint] === "online");
        },
        activeJob(job) {
            return ![ "completed", "failed", "cancelled" ].includes(job.state);
        },
        shortID(id) {
            return id.replace(/^sha256:/, "").slice(0, 12);
        },
        bytes(value) {
            if (!value) {
                return "0 B";
            }
            const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
            return (value / 1024 ** power).toFixed(power ? 1 : 0) + " " + [ "B", "KiB", "MiB", "GiB", "TiB" ][power];
        },
        date(value) {
            return new Date(value).toLocaleString();
        },
        async load() {
            const version = ++this.requestVersion;
            this.error = "";
            this.loading = false;
            if (!this.available || this.disposed) {
                this.images = [];
                return;
            }
            const endpoint = this.endpoint;
            this.loading = true;
            try {
                const result = await imageRequest(this.$root, { action: "list",
                    endpoint });
                if (version === this.requestVersion) {
                    this.images = result.images;
                    this.details = {};
                    for (const image of this.images.filter(image => this.expanded[image.id])) {
                        this.loadDetails(image, endpoint, version);
                    }
                }
            } catch (error) {
                if (version === this.requestVersion) {
                    this.error = error.message;
                }
            } finally {
                if (version === this.requestVersion) {
                    this.loading = false;
                }
            }
        },
        expand(image) {
            this.expanded[image.id] = !this.expanded[image.id];
            if (this.expanded[image.id] && !this.details[image.id]) {
                this.loadDetails(image, this.endpoint, this.requestVersion);
            }
        },
        async loadDetails(image, endpoint, version) {
            try {
                const result = await imageRequest(this.$root, { action: "inspect",
                    endpoint,
                    id: image.id });
                if (version === this.requestVersion) {
                    this.details[image.id] = result.image;
                }
            } catch (error) {
                if (version === this.requestVersion) {
                    this.error = error.message;
                }
            }
        },
        async action(image, request, endpoint = this.endpoint) {
            this.busy[image.id] = true;
            try {
                const result = await imageRequest(this.$root, { ...request,
                    endpoint,
                    id: image.id });
                if (endpoint === this.endpoint && ![ "download", "copy" ].includes(request.action)) {
                    await this.load();
                }
                return result;
            } catch (error) {
                this.$root.toastError(error.message);
                if (endpoint === this.endpoint) {
                    this.load();
                }
                return null;
            } finally {
                this.busy[image.id] = false;
            }
        },
        async download(image) {
            const result = await this.action(image, { action: "download" });
            if (result) {
                const link = document.createElement("a");
                link.href = `/api/image-transfers/${encodeURIComponent(result.ticket)}`;
                link.download = "";
                document.body.appendChild(link);
                link.click();
                link.remove();
            }
        },
        deleteImage(image) {
            if (window.confirm(this.$t("Delete this image and all its tags?") + "\n" + this.deviceName(this.endpoint) + "\n" + [ image.id, ...image.tags ].join("\n"))) {
                this.action(image, { action: "delete",
                    confirmed: true });
            }
        },
        removeTag(image, reference) {
            const message = image.tags.length === 1 ? this.$t("Remove the last tag? This may delete the image.") : this.$t("Remove this tag?");
            if (window.confirm(message + "\n" + reference)) {
                this.action(image, { action: "untag",
                    reference,
                    confirmed: true });
            }
        },
        openTag(image) {
            this.selected = image;
            this.tagReference = "";
            this.tagDialog = true;
        },
        async tag() {
            const image = this.selected;
            const endpoint = this.endpoint;
            const reference = this.tagReference.trim();
            const result = await this.action(image, { action: "tag",
                reference }, endpoint);
            if (result?.conflicts?.length && window.confirm(this.$t("Replace existing tags?") + "\n" + result.conflicts.join("\n"))) {
                await this.action(image, { action: "tag",
                    reference,
                    confirmed: true }, endpoint);
            }
        },
        async pull() {
            try {
                await imageRequest(this.$root, { action: "pull",
                    endpoint: this.endpoint,
                    reference: this.reference.trim() });
            } catch (error) {
                this.$root.toastError(error.message);
            }
        },
        openCopy(image) {
            this.selected = image;
            this.copyDestination = this.destinations[0]?.endpoint ?? null;
            this.copyDialog = true;
        },
        async copy() {
            const image = this.selected;
            const endpoint = this.endpoint;
            const destination = this.copyDestination;
            const result = await this.action(image, { action: "copy",
                destination }, endpoint);
            if (!result) {
                return;
            }
            let message = this.$t("Copy this image and all its tags?") + "\n" + this.deviceName(endpoint) + " → " + this.deviceName(destination);
            if (result.conflicts?.length) {
                message += "\n" + this.$t("Replace existing tags?") + "\n" + result.conflicts.join("\n");
            }
            if (window.confirm(message)) {
                await this.action(image, { action: "copy",
                    destination,
                    confirmed: true }, endpoint);
            }
        },
        selectFile(event) {
            this.upload(event.target.files);
            event.target.value = "";
        },
        dropFiles(event) {
            this.dragging = false;
            this.upload(event.dataTransfer.files);
        },
        upload(files) {
            if (!this.available || !files.length) {
                return;
            }
            if (files.length !== 1 || !/\.(tar|tar\.gz|tgz)$/i.test(files[0].name)) {
                this.$root.toastError(this.$t("Choose one .tar, .tar.gz or .tgz image archive"));
                return;
            }
            const endpoint = this.endpoint;
            if (window.confirm(this.$t("Load this archive? Existing image tags may be replaced.") + "\n" + files[0].name + " → " + this.deviceName(endpoint))) {
                uploadArchive(this.$root, endpoint, files[0]).catch(error => this.$root.toastError(error.message));
            }
        },
        cancel(job) {
            cancelUpload(job.id);
            imageRequest(this.$root, { action: "cancel",
                endpoint: "",
                jobId: job.id }).catch(error => this.$root.toastError(error.message));
        },
    },
};
