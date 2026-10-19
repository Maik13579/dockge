<template>
    <div class="shadow-box container" :class="compactLayout ? 'compact-container mb-2' : 'big-padding mb-3'">
        <div class="row service-summary">
            <div class="col-5 service-info">
                <div class="service-identity">
                    <div class="service-name">
                        <h4 :title="name">{{ name }}</h4>
                        <button v-if="compact && !isEditMode" type="button" class="btn btn-sm btn-normal details-toggle" :title="$t(expandedCompact ? 'Hide details' : 'Show details')" :aria-label="$t(expandedCompact ? 'Hide details' : 'Show details')" :aria-expanded="expandedCompact" @click="expandedCompact = !expandedCompact">
                            <font-awesome-icon :icon="expandedCompact ? 'chevron-up' : 'chevron-down'" />
                        </button>
                    </div>
                    <span v-if="isIncluded && !compactLayout" class="badge bg-secondary mb-2">{{ $t(hasOverrides ? "Overrides" : "Included") }}</span>
                </div>
                <div v-show="!compactLayout" class="image mb-2">
                    <span class="me-1">{{ imageName }}:</span><span class="tag">{{ imageTag }}</span>
                </div>
                <div v-if="!isEditMode" class="service-status">
                    <span class="badge me-1" :class="bgStyle">{{ status }}</span>
                    <span v-if="health" class="badge me-1" :class="health === 'unhealthy' ? 'bg-danger' : 'bg-secondary'">
                        {{ $t("Health") }}: {{ health }}
                    </span>

                    <template v-if="!compactLayout">
                        <a v-for="(port, index) in envsubstService.ports" :key="index" :href="parsePort(port).url" target="_blank">
                            <span class="badge me-1 bg-secondary">{{ parsePort(port).display }}</span>
                        </a>
                    </template>
                </div>
                <div v-if="compactLayout" class="compact-stats stats" :title="serviceStatus && serviceStatus.length > 1 ? $t('Expand for per-container statistics') : ''">
                    <span>{{ $t("CPU") }}: {{ compactStats?.CPUPerc || "—" }}</span>
                    <span>{{ $t("memoryAbbreviated") }}: {{ compactStats?.MemUsage || "—" }}</span>
                </div>
            </div>
            <div class="col-7 service-controls">
                <div class="function">
                    <div class="service-actions" role="group">
                        <router-link v-if="!isEditMode && isRunning && !compactLayout" class="btn btn-normal" :to="terminalRouteLink" title="Bash" aria-label="Bash" disabled="">
                            <font-awesome-icon icon="terminal" />
                            <span :class="{ 'visually-hidden': compactLayout }">Bash</span>
                        </router-link>
                        <button
                            v-if="!isEditMode && !isRunning"
                            class="btn btn-primary"
                            :title="$t('startStack')"
                            :aria-label="$t('startStack')"
                            :disabled="processing"
                            @click="startService"
                        >
                            <font-awesome-icon icon="play" :class="{ 'me-1': !compactLayout }" />
                            <span :class="{ 'visually-hidden': compactLayout }">{{ $t("startStack") }}</span>
                        </button>
                        <router-link v-if="!isEditMode && !compactLayout" class="btn btn-normal" :to="logsRouteLink" :title="$t('Logs')" :aria-label="$t('Logs')">
                            <font-awesome-icon icon="stream" :class="{ 'me-1': !compactLayout }" />
                            <span :class="{ 'visually-hidden': compactLayout }">{{ $t("Logs") }}</span>
                        </router-link>
                        <button
                            v-if="!isEditMode && isRunning && !compactLayout"
                            class="btn btn-normal"
                            :title="$t('restartStack')"
                            :aria-label="$t('restartStack')"
                            :disabled="processing"
                            @click="restartService"
                        >
                            <font-awesome-icon icon="rotate" :class="{ 'me-1': !compactLayout }" />
                            <span :class="{ 'visually-hidden': compactLayout }">{{ $t("restartStack") }}</span>
                        </button>
                        <button
                            v-if="!isEditMode && isRunning"
                            class="btn btn-normal"
                            :title="$t('stopStack')"
                            :aria-label="$t('stopStack')"
                            :disabled="processing"
                            @click="stopService"
                        >
                            <font-awesome-icon icon="stop" :class="{ 'me-1': !compactLayout }" />
                            <span :class="{ 'visually-hidden': compactLayout }">{{ $t("stopStack") }}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="isEditMode" class="mt-2">
            <button class="btn btn-normal me-2" @click="showConfig = !showConfig">
                <font-awesome-icon icon="edit" />
                {{ $t("Edit") }}
            </button>
            <button v-if="false" class="btn btn-normal me-2">Rename</button>
            <button v-if="!isIncluded && !hasOverrides" class="btn btn-danger me-2" @click="remove">
                <font-awesome-icon icon="trash" />
                {{ $t("deleteContainer") }}
            </button>
        </div>
        <div v-else-if="!compactLayout && statsInstances.length > 0" class="mt-2">
            <div class="d-flex align-items-center gap-3">
                <template v-if="!expandedStats">
                    <div class="stats">
                        {{ $t('CPU') }}: {{ statsInstances[0].CPUPerc }}
                    </div>
                    <div class="stats">
                        {{ $t('memoryAbbreviated') }}: {{ statsInstances[0].MemUsage }}
                    </div>
                </template>
                <div class="d-flex flex-grow-1 justify-content-end">
                    <button class="btn btn-sm btn-normal" @click="expandedStats = !expandedStats">
                        <font-awesome-icon :icon="expandedStats ? 'chevron-up' : 'chevron-down'" />
                    </button>
                </div>
            </div>
            <transition name="slide-fade" appear>
                <div v-if="expandedStats" class="d-flex flex-column gap-3 mt-2">
                    <DockerStat
                        v-for="stat in statsInstances"
                        :key="stat.Name"
                        :stat="stat"
                    />
                </div>
            </transition>
        </div>

        <transition name="slide-fade" appear>
            <div v-if="isEditMode && showConfig" class="config mt-3">
                <!-- Image -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("dockerImage") }}
                    </label>
                    <div class="input-group mb-3">
                        <input
                            v-model="service.image"
                            class="form-control"
                            list="image-datalist"
                            @input="updateField('image')"
                        />
                    </div>

                    <!-- TODO: Search online: https://hub.docker.com/api/content/v1/products/search?q=louislam%2Fuptime&source=community&page=1&page_size=4 -->
                    <datalist id="image-datalist">
                        <option value="louislam/uptime-kuma:1" />
                    </datalist>
                    <div class="form-text"></div>
                </div>

                <!-- Ports -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $tc("port", 2) }}
                    </label>
                    <ArrayInput name="ports" :display-name="$t('port')" placeholder="HOST:CONTAINER" @change="updateField('ports')" />
                </div>

                <!-- Volumes -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $tc("volume", 2) }}
                    </label>
                    <ArrayInput name="volumes" :display-name="$t('volume')" placeholder="HOST:CONTAINER" @change="updateField('volumes')" />
                </div>

                <!-- Restart Policy -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("restartPolicy") }}
                    </label>
                    <select v-model="service.restart" class="form-select" @change="updateField('restart')">
                        <option value="always">{{ $t("restartPolicyAlways") }}</option>
                        <option value="unless-stopped">{{ $t("restartPolicyUnlessStopped") }}</option>
                        <option value="on-failure">{{ $t("restartPolicyOnFailure") }}</option>
                        <option value="no">{{ $t("restartPolicyNo") }}</option>
                    </select>
                </div>

                <!-- Environment Variables -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $tc("environmentVariable", 2) }}
                    </label>
                    <ArrayInput name="environment" :display-name="$t('environmentVariable')" placeholder="KEY=VALUE" @change="updateField('environment')" />
                </div>

                <!-- Container Name -->
                <div v-if="false" class="mb-4">
                    <label class="form-label">
                        {{ $t("containerName") }}
                    </label>
                    <div class="input-group mb-3">
                        <input
                            v-model="service.container_name"
                            class="form-control"
                            @input="updateField('container_name')"
                        />
                    </div>
                    <div class="form-text"></div>
                </div>

                <!-- Network -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $tc("network", 2) }}
                    </label>

                    <div v-if="networkList.length === 0 && service.networks && service.networks.length > 0" class="text-warning mb-3">
                        {{ $t("NoNetworksAvailable") }}
                    </div>

                    <ArraySelect name="networks" :display-name="$t('network')" placeholder="Network Name" :options="networkList" @change="updateField('networks')" />
                </div>

                <!-- Depends on -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("dependsOn") }}
                    </label>
                    <ArrayInput name="depends_on" :display-name="$t('dependsOn')" :placeholder="$t(`containerName`)" @change="updateField('depends_on')" />
                </div>
            </div>
        </transition>
    </div>
</template>

<script>
import { defineComponent } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { parseDockerPort } from "../../../common/util-common";
import DockerStat from "./DockerStat.vue";

export default defineComponent({
    components: {
        FontAwesomeIcon,
        DockerStat
    },
    props: {
        compact: {
            type: Boolean,
            default: false,
        },
        isIncluded: {
            type: Boolean,
            default: false,
        },
        hasOverrides: {
            type: Boolean,
            default: false,
        },
        name: {
            type: String,
            required: true,
        },
        isEditMode: {
            type: Boolean,
            default: false,
        },
        first: {
            type: Boolean,
            default: false,
        },
        serviceStatus: {
            type: Object,
            default: null,
        },
        dockerStats: {
            type: Object,
            default: null
        }
    },
    emits: [
        "start-service",
        "stop-service",
        "restart-service",
        "update-service",
        "remove-service"
    ],
    data() {
        return {
            showConfig: false,
            expandedStats: false,
            expandedCompact: false,
        };
    },
    computed: {

        compactLayout() {
            return !!this.compact && !this.isEditMode && !this.expandedCompact;
        },

        compactStats() {
            // Replicas have separate statistics in the expanded card.
            return this.serviceStatus?.length === 1 && this.statsInstances.length === 1 ? this.statsInstances[0] : null;
        },

        networkList() {
            let list = [];
            for (const networkName in this.jsonObject.networks) {
                list.push(networkName);
            }
            return list;
        },

        bgStyle() {
            if (this.status === "running" || this.status === "healthy") {
                return "bg-primary";
            } else if (this.status === "unhealthy") {
                return "bg-danger";
            } else {
                return "bg-secondary";
            }
        },

        terminalRouteLink() {
            if (this.endpoint) {
                return {
                    name: "containerTerminalEndpoint",
                    params: {
                        endpoint: this.endpoint,
                        stackName: this.stackName,
                        serviceName: this.name,
                        type: "bash",
                    },
                };
            } else {
                return {
                    name: "containerTerminal",
                    params: {
                        stackName: this.stackName,
                        serviceName: this.name,
                        type: "bash",
                    },
                };
            }
        },

        logsRouteLink() {
            return {
                name: this.endpoint ? "containerLogsEndpoint" : "containerLogs",
                params: {
                    stackName: this.stackName,
                    serviceName: this.name,
                    ...(this.endpoint ? { endpoint: this.endpoint } : {}),
                },
            };
        },

        endpoint() {
            return this.$parent.$parent.endpoint;
        },

        stack() {
            return this.$parent.$parent.stack;
        },

        stackName() {
            return this.$parent.$parent.stack.name;
        },

        service() {
            if (!this.jsonObject.services[this.name]) {
                return {};
            }
            return this.jsonObject.services[this.name];
        },

        processing() {
            const page = this.$parent.$parent;
            return page.stopping || !!page.serviceOperations[this.name]
                || (page.processing && !page.operationRunning);
        },

        isRunning() {
            return (this.serviceStatus || []).some(instance => instance.state
                ? [ "running", "restarting", "paused" ].includes(instance.state)
                : [ "running", "healthy", "unhealthy", "starting" ].includes(instance.status));
        },

        jsonObject() {
            return this.$parent.$parent.serviceConfig;
        },

        envsubstJSONConfig() {
            return this.$parent.$parent.displayEnvConfig;
        },

        envsubstService() {
            if (!this.envsubstJSONConfig.services[this.name]) {
                return {};
            }
            return this.envsubstJSONConfig.services[this.name];
        },

        imageName() {
            if (this.envsubstService.image) {
                return this.envsubstService.image.split(":")[0];
            } else {
                return "";
            }
        },

        imageTag() {
            if (this.envsubstService.image) {
                let tag = this.envsubstService.image.split(":")[1];

                if (tag) {
                    return tag;
                } else {
                    return "latest";
                }
            } else {
                return "";
            }
        },
        statsInstances() {
            if (!this.serviceStatus) {
                return [];
            }

            return this.serviceStatus
                .map(s => this.dockerStats[s.name])
                .filter(s => !!s)
                .sort((a, b) => a.Name.localeCompare(b.Name));
        },
        status() {
            if (!this.serviceStatus?.length) {
                return "N/A";
            }
            const states = this.serviceStatus.map(instance => instance.state || instance.status);
            // A stopped replica must not hide another replica that is running.
            return [ "running", "restarting", "paused", "unhealthy", "starting", "healthy" ].find(state => states.includes(state)) || states[0];
        },

        health() {
            const checks = (this.serviceStatus || [])
                .filter(instance => instance.state === "running")
                .map(instance => instance.health)
                .filter(Boolean);
            return [ "unhealthy", "starting", "healthy" ].find(value => checks.includes(value)) || "";
        }
    },
    mounted() {
        if (this.first) {
            //this.showConfig = true;
        }
    },
    methods: {
        parsePort(port) {
            // Canonical Compose ports use objects; local YAML can use either form.
            if (port && typeof port === "object") {
                port = `${port.published || port.target}/${port.protocol || "tcp"}`;
            }
            if (this.stack.endpoint) {
                return parseDockerPort(port, this.stack.primaryHostname);
            } else {
                let hostname = this.$root.info.primaryHostname || location.hostname;
                return parseDockerPort(port, hostname);
            }
        },
        remove() {
            this.$emit("remove-service", this.name);
        },
        /** Tell the source editor which field was changed in the service form. */
        updateField(field) {
            this.$emit("update-service", {
                name: this.name,
                field,
                value: this.service[field],
            });
        },
        startService() {
            this.$emit("start-service", this.name);
        },
        stopService() {
            this.$emit("stop-service", this.name);
        },
        restartService() {
            this.$emit("restart-service", this.name);
        }

    }
});
</script>

<style scoped lang="scss">
@import "../styles/vars";

.container {
    .service-name {
        display: flex;
        align-items: center;
        gap: 0.5rem;

        h4 {
            min-width: 0;
            overflow-wrap: anywhere;
        }
    }

    .details-toggle {
        flex-shrink: 0;
        padding: 0.15rem 0.4rem;
    }

    .image {
        font-size: 0.8rem;
        color: #6c757d;
        .tag {
            color: #33383b;
        }
    }

    .function {
        align-content: center;
        display: flex;
        height: 100%;
        width: 100%;
        align-items: center;
        justify-content: end;
    }

    .service-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.5rem;

        .btn {
            padding-left: 0.5rem;
            padding-right: 0.5rem;
            white-space: nowrap;
        }
    }

    .stats {
        font-size: 0.8rem;
        color: #6c757d;
    }

    &.compact-container {
        padding: 0.5rem 0.75rem;

        .service-summary {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: center;
            gap: 0.75rem;
            margin: 0;
        }

        .service-info,
        .service-controls {
            width: auto;
            padding: 0;
        }

        .service-info,
        .service-identity,
        .service-status,
        .compact-stats {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 0.25rem 0.75rem;
            min-width: 0;
        }

        .service-identity {
            flex: 1 1 10rem;
        }

        .service-name {
            flex: 1;
            min-width: 0;

            h4 {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 0.95rem;
                margin: 0;
            }
        }

        .compact-stats span {
            white-space: nowrap;
        }

        .service-actions {
            grid-template-columns: none;
            grid-auto-flow: column;
            grid-auto-columns: 2rem;
            gap: 0.25rem;

            .btn {
                padding: 0.25rem;
                font-size: 0.875rem;
            }
        }
    }
}
</style>
