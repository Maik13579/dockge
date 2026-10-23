<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 v-if="isAdd" class="mb-3">{{ $t("compose") }}</h1>
            <h1 v-else class="mb-3">
                <Uptime :stack="globalStack || stack" :pill="true" /> {{ stack.name }}
                <span v-if="$root.agentCount > 1 && endpoint !== ''" class="agent-name">
                    ({{ endpointDisplay }})
                </span>
            </h1>

            <div v-if="stack.isManagedByDockge" class="mb-3">
                <div class="btn-group me-2" role="group">
                    <button v-if="isEditMode" class="btn btn-primary" :disabled="stackBusy" @click="deployStack">
                        <font-awesome-icon icon="rocket" class="me-1" />
                        {{ $t("deployStack") }}
                    </button>

                    <button v-if="isEditMode" class="btn btn-normal" :disabled="stackBusy" @click="saveStack">
                        <font-awesome-icon icon="save" class="me-1" />
                        {{ $t("saveStackDraft") }}
                    </button>

                    <button v-if="!isEditMode" class="btn btn-secondary" :disabled="stackBusy" @click="enableEditMode">
                        <font-awesome-icon icon="pen" class="me-1" />
                        {{ $t("editStack") }}
                    </button>

                    <button v-if="!isEditMode" class="btn btn-primary" :disabled="stackBusy" @click="startStack">
                        <font-awesome-icon icon="play" class="me-1" />
                        {{ $t("Up") }}
                    </button>

                    <button v-if="!isEditMode && active" class="btn btn-normal " :disabled="stackBusy" @click="restartStack">
                        <font-awesome-icon icon="rotate" class="me-1" />
                        {{ $t("restartStack") }}
                    </button>

                    <button v-if="!isEditMode" class="btn btn-normal" :disabled="stackBusy" @click="pullStack">
                        <font-awesome-icon icon="cloud-arrow-down" class="me-1" />
                        {{ $t("Pull") }}
                    </button>

                    <BDropdown v-if="!isEditMode" right text="" variant="normal">
                        <BDropdownItem :disabled="stackBusy || !canBuildStack" :title="$t(containerManagement ? (canBuildStack ? 'Build' : 'No build configuration') : 'Update agent')" @click="runStackOperation('buildStack')">{{ $t("Build") }}</BDropdownItem>
                    </BDropdown>

                    <button v-if="!isEditMode || operationRunning" class="btn btn-normal" :disabled="stopping" @click="stopStack">
                        <font-awesome-icon icon="stop" class="me-1" />
                        {{ $t("stopStack") }}
                    </button>

                    <BDropdown right text="" variant="normal">
                        <BDropdownItem :disabled="stopping" @click="stopStack">
                            <font-awesome-icon icon="stop" class="me-1" />
                            {{ $t("stopStack") }}
                        </BDropdownItem>
                        <BDropdownItem :disabled="stopping" @click="downStack">
                            <font-awesome-icon icon="stop" class="me-1" />
                            {{ $t("Down") }}
                        </BDropdownItem>
                        <BDropdownItem :disabled="stopping" @click="killStack">
                            <font-awesome-icon icon="times-circle" class="me-1" />
                            {{ $t("Kill") }}
                        </BDropdownItem>
                    </BDropdown>
                </div>

                <button v-if="isEditMode && !isAdd" class="btn btn-normal" :disabled="stackBusy" @click="discardStack">{{ $t("discardStack") }}</button>
                <button v-if="!isEditMode" class="btn btn-danger" :disabled="stackBusy" @click="showDeleteDialog = !showDeleteDialog">
                    <font-awesome-icon icon="trash" class="me-1" />
                    {{ $t("deleteStack") }}
                </button>
            </div>

            <!-- URLs -->
            <div v-if="urls.length > 0" class="mb-3">
                <a v-for="(urlItem, index) in urls" :key="index" target="_blank" :href="urlItem.url">
                    <span class="badge bg-secondary me-2">{{ urlItem.display }}</span>
                </a>
            </div>

            <!-- Progress Terminal -->
            <transition name="slide-fade" appear>
                <Terminal
                    v-show="showProgressTerminal"
                    ref="progressTerminal"
                    class="mb-3 terminal"
                    :name="terminalName"
                    :endpoint="endpoint"
                    :rows="progressTerminalRows"
                    @has-data="showProgressTerminal = true; submitted = true;"
                ></Terminal>
            </transition>

            <div v-if="stack.isManagedByDockge" class="row">
                <div :class="showComposeFiles ? 'col-lg-6' : 'col-12'">
                    <!-- General -->
                    <div v-if="isAdd">
                        <h4 class="mb-3">{{ $t("general") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- Stack Name -->
                            <div>
                                <label for="name" class="form-label">{{ $t("stackName") }}</label>
                                <input id="name" v-model="stack.name" type="text" class="form-control" required @blur="stackNameToLowercase">
                                <div class="form-text">{{ $t("Lowercase only") }}</div>
                            </div>

                            <!-- Endpoint -->
                            <div class="mt-3">
                                <label for="name" class="form-label">{{ $t("dockgeAgent") }}</label>
                                <select v-model="stack.endpoint" class="form-select">
                                    <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] != 'online'">
                                        ({{ $root.agentStatusList[agentEndpoint] }}) {{ $root.endpointDisplayFunction(agentEndpoint) }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- Containers -->
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
                        <h4 class="mb-0">{{ $tc("container", 2) }}</h4>
                        <ContainerListOptions v-if="!isEditMode" :columns="containerColumns" :sort="containerSort" :direction="containerDirection" @change="setContainerOptions">
                            <div class="btn-group" role="group" :aria-label="$t('Container view')">
                                <button type="button" class="btn btn-sm btn-normal" :class="{ active: !compactView }" :aria-pressed="!compactView" @click="setContainerView(false)">{{ $t("Cards") }}</button>
                                <button type="button" class="btn btn-sm btn-normal" :class="{ active: compactView }" :aria-pressed="compactView" @click="setContainerView(true)">{{ $t("Compact") }}</button>
                            </div>
                        </ContainerListOptions>
                    </div>
                    <div v-if="!showComposeFiles && resolvingConfig" class="mb-3 text-secondary" role="status">{{ $t("Resolving Compose configuration...") }}</div>
                    <div v-if="!showComposeFiles && configError" class="mb-3 text-warning" role="alert">{{ $t("Compose configuration could not be resolved") }}: {{ configError }}</div>
                    <div v-if="!isEditMode && containerErrorCount" class="alert alert-danger" role="status">
                        {{ $t("Containers need attention") }}: {{ containerErrorCount }}
                    </div>
                    <div v-if="serviceStatusError" class="text-warning mb-3" role="status">
                        {{ $t("Unable to refresh container status") }}: {{ serviceStatusError }}
                    </div>

                    <div v-if="isEditMode" class="input-group mb-3">
                        <input
                            v-model="newContainerName"
                            :placeholder="$t(`New Container Name...`)"
                            class="form-control"
                            @keyup.enter="addContainer"
                        />
                        <button class="btn btn-primary" @click="addContainer">
                            {{ $t("addContainer") }}
                        </button>
                    </div>

                    <div ref="containerList" class="container-grid-scope">
                        <div class="container-grid" :data-columns="isEditMode ? 1 : containerColumns">
                            <Container
                                v-for="(name, index) in sortedServiceNames"
                                :key="name"
                                :name="name"
                                :compact="compactView"
                                :is-edit-mode="isEditMode"
                                :first="index === 0"
                                :is-included="!jsonConfig.services[name]"
                                :has-overrides="!!overrideConfig.services[name]"
                                :serviceStatus="serviceStatusList[name]"
                                :dockerStats="dockerStats"
                                @start-service="startService"
                                @stop-service="stopService"
                                @kill-service="killService"
                                @pull-service="pullService"
                                @build-service="buildService"
                                @down-service="downService"
                                @rm-service="rmService"
                                @restart-service="restartService"
                                @update-service="updateService"
                                @remove-service="removeService"
                            />
                        </div>
                    </div>

                    <button v-if="false && isEditMode && jsonConfig.services && Object.keys(jsonConfig.services).length > 0" class="btn btn-normal mb-3" @click="addContainer">{{ $t("addContainer") }}</button>

                    <!-- General -->
                    <div v-if="isEditMode">
                        <h4 class="mb-3">{{ $t("extra") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- URLs -->
                            <div class="mb-4">
                                <label class="form-label">
                                    {{ $tc("url", 2) }}
                                </label>
                                <ArrayInput name="urls" :display-name="$t('url')" placeholder="https://" object-type="x-dockge" />
                            </div>
                        </div>
                    </div>

                    <!-- Combined Terminal Output -->
                    <div v-show="!isEditMode">
                        <h4 class="mb-3">{{ $t("terminal") }}</h4>
                        <Terminal
                            ref="combinedTerminal"
                            class="mb-3 terminal"
                            :name="combinedTerminalName"
                            :endpoint="endpoint"
                            :rows="combinedTerminalRows"
                            :cols="combinedTerminalCols"
                            style="height: 315px;"
                        ></Terminal>
                    </div>
                </div>
                <div v-if="showComposeFiles" class="col-lg-6">
                    <div class="btn-group mb-3" role="group" :aria-label="$t('Compose file')">
                        <button type="button" class="btn btn-normal" :class="{ active: activeDocument === 'compose' }" :aria-pressed="activeDocument === 'compose'" :title="stack.composeFileName || 'compose.yaml'" @click="activeDocument = 'compose'">{{ $t("compose") }}</button>
                        <button type="button" class="btn btn-normal" :class="{ active: activeDocument === 'overrides' }" :aria-pressed="activeDocument === 'overrides'" :title="stack.composeOverrideFileName || 'compose.override.yaml'" @click="activeDocument = 'overrides'">{{ $t("Overrides") }}</button>
                    </div>

                    <!-- YAML editor -->
                    <div class="shadow-box mb-3 editor-box" :class="{'edit-mode' : isEditMode}">
                        <code-mirror
                            ref="editor"
                            :key="activeDocument"
                            v-model="activeYAML"
                            :extensions="extensions"
                            minimal
                            wrap="true"
                            dark="true"
                            tab="true"
                            :disabled="!isEditMode"
                            :hasFocus="editorFocus"
                            @change="yamlCodeChange"
                        />
                    </div>
                    <div v-if="isEditMode && yamlError" class="mb-3 text-danger">
                        {{ yamlError }}
                    </div>
                    <div v-if="resolvingConfig" class="mb-3 text-secondary" role="status">{{ $t("Resolving Compose configuration...") }}</div>
                    <div v-if="configError" class="mb-3 text-warning" role="alert">{{ $t("Compose configuration could not be resolved") }}: {{ configError }}</div>

                    <!-- ENV editor -->
                    <div v-if="isEditMode">
                        <h4 class="mb-3">.env</h4>
                        <div class="shadow-box mb-3 editor-box" :class="{'edit-mode' : isEditMode}">
                            <code-mirror
                                ref="editor"
                                v-model="stack.composeENV"
                                :extensions="extensionsEnv"
                                minimal
                                wrap="true"
                                dark="true"
                                tab="true"
                                :disabled="!isEditMode"
                                :hasFocus="editorFocus"
                                @change="yamlCodeChange"
                            />
                        </div>
                    </div>

                    <div v-if="isEditMode">
                        <!-- Volumes -->
                        <div v-if="false">
                            <h4 class="mb-3">{{ $tc("volume", 2) }}</h4>
                            <div class="shadow-box big-padding mb-3">
                            </div>
                        </div>

                        <!-- Networks -->
                        <h4 class="mb-3">{{ $tc("network", 2) }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <NetworkInput />
                        </div>
                    </div>

                    <!-- <div class="shadow-box big-padding mb-3">
                        <div class="mb-3">
                            <label for="name" class="form-label"> Search Templates</label>
                            <input id="name" v-model="name" type="text" class="form-control" placeholder="Search..." required>
                        </div>

                        <prism-editor v-if="false" v-model="yamlConfig" class="yaml-editor" :highlight="highlighter" line-numbers @input="yamlCodeChange"></prism-editor>
                    </div>-->
                </div>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>

            <!-- Delete Dialog -->
            <BModal v-model="showDeleteDialog" :cancelTitle="$t('cancel')" :okTitle="$t('deleteStack')" okVariant="danger" @ok="deleteDialog">
                {{ $t("deleteStackMsg") }}
            </BModal>
        </div>
    </transition>
</template>

<script>
import CodeMirror from "vue-codemirror6";
import ContainerListOptions from "../components/ContainerListOptions.vue";
import { containerPreferences, compareContainers } from "../container-presentation";
import { countContainerIssues } from "../container-status";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { dracula as editorTheme } from "thememirror";
import { lineNumbers, EditorView } from "@codemirror/view";
import { Document } from "yaml";

import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import {
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    copyYAMLComments, envsubstYAML,
    getCombinedTerminalName,
    getComposeTerminalName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING
} from "../../../common/util-common";
import { BModal } from "bootstrap-vue-next";
import NetworkInput from "../components/NetworkInput.vue";
import dotenv from "dotenv";
import { ref } from "vue";
import { editableService, parseComposeDocument, updateOverride } from "../compose-editor";

const template = `
services:
  nginx:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
`;
const envDefault = "# VARIABLE=value #comment";
const validationDelay = 3000;

let yamlErrorTimeout = null;

let dockerStatsTimeout = null;

export default {
    components: {
        ContainerListOptions,
        NetworkInput,
        FontAwesomeIcon,
        CodeMirror,
        BModal,
    },
    beforeRouteUpdate(to, from, next) {
        this.exitConfirm(next);
    },
    beforeRouteLeave(to, from, next) {
        this.exitConfirm(next);
    },
    setup() {
        const editorFocus = ref(false);

        const focusEffectHandler = (state, focusing) => {
            editorFocus.value = focusing;
            return null;
        };

        const extensions = [
            editorTheme,
            yaml(),
            lineNumbers(),
            EditorView.focusChangeEffect.of(focusEffectHandler)
        ];

        const extensionsEnv = [
            editorTheme,
            python(),
            lineNumbers(),
            EditorView.focusChangeEffect.of(focusEffectHandler)
        ];

        return { extensions,
            extensionsEnv,
            editorFocus };
    },
    yamlDoc: null,  // For keeping the yaml comments
    data() {
        return {
            jsonConfig: { services: {} },
            sourceConfigSnapshot: "",
            overrideConfig: { services: {} },
            resolvedConfig: {},
            resolvedEditorServices: {},
            activeDocument: "compose",
            configError: "",
            resolvingConfig: false,
            configTimeout: null,
            configResponseTimeout: null,
            configRequest: 0,
            envsubstJSONConfig: {},
            yamlError: "",
            processing: true,
            stopping: false,
            operationRunning: false,
            operationRequest: 0,
            serviceOperations: Object.create(null),
            serviceOperationRequest: 0,
            showProgressTerminal: false,
            progressTerminalRows: PROGRESS_TERMINAL_ROWS,
            combinedTerminalRows: COMBINED_TERMINAL_ROWS,
            combinedTerminalCols: COMBINED_TERMINAL_COLS,
            stack: {

            },
            serviceStatusList: {},
            serviceStatusTimeout: null,
            serviceStatusRequest: 0,
            serviceStatusError: "",
            dockerStats: {},
            ...containerPreferences(localStorage),
            compactView: localStorage.containerView === "compact",
            isEditMode: false,
            submitted: false,
            showDeleteDialog: false,
            newContainerName: "",
            stopServiceStatusTimeout: false,
            stopDockerStatsTimeout: false,
        };
    },
    computed: {
        containerManagement() {
            return this.endpoint ? this.$root.containerCapabilities?.[this.endpoint] === true : this.$root.info?.containerManagement === true;
        },
        canBuildStack() {
            return this.containerManagement && Object.values(this.serviceConfig.services || {}).some(service => service.build);
        },
        stackBusy() {
            return this.processing || Object.keys(this.serviceOperations).length > 0;
        },

        containerErrorCount() {
            return countContainerIssues(Object.values(this.serviceStatusList).flat());
        },

        sortedServiceNames() {
            const names = Object.keys(this.serviceConfig.services);
            // Keep forms in source order while editing, including newly added services.
            if (this.isEditMode) {
                return names;
            }
            return names.sort((left, right) => compareContainers({ name: left,
                instances: this.serviceStatusList[left],
                stats: this.dockerStats },
            { name: right,
                instances: this.serviceStatusList[right],
                stats: this.dockerStats }, this.containerSort, this.containerDirection));
        },

        activeYAML: {
            get() {
                return this.activeDocument === "compose" ? this.stack.composeYAML : this.stack.composeOverrideYAML;
            },
            set(value) {
                if (this.activeDocument === "compose") {
                    this.stack.composeYAML = value;
                } else {
                    this.stack.composeOverrideYAML = value;
                }
            },
        },

        serviceConfig() {
            // Form fields are drafts too: mutate the source only through the
            // explicit field event, after deciding which document owns the edit.
            const services = JSON.parse(JSON.stringify(this.jsonConfig.services));
            for (const [ name, service ] of Object.entries(this.resolvedEditorServices)) {
                if (!services[name] || this.overrideConfig.services[name]) {
                    services[name] = service;
                }
            }
            return {
                ...this.jsonConfig,
                networks: {
                    ...this.resolvedConfig.networks,
                    ...this.jsonConfig.networks,
                },
                services,
            };
        },

        displayEnvConfig() {
            return {
                ...this.envsubstJSONConfig,
                services: {
                    ...this.envsubstJSONConfig.services,
                    ...this.resolvedConfig.services,
                },
            };
        },

        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },

        urls() {
            if (!this.envsubstJSONConfig["x-dockge"] || !this.envsubstJSONConfig["x-dockge"].urls || !Array.isArray(this.envsubstJSONConfig["x-dockge"].urls)) {
                return [];
            }

            let urls = [];
            for (const url of this.envsubstJSONConfig["x-dockge"].urls) {
                let display;
                try {
                    let obj = new URL(url);
                    let pathname = obj.pathname;
                    if (pathname === "/") {
                        pathname = "";
                    }
                    display = obj.host + pathname + obj.search;
                } catch (e) {
                    display = url;
                }

                urls.push({
                    display,
                    url,
                });
            }
            return urls;
        },

        isAdd() {
            return this.$route.path === "/compose" && !this.submitted;
        },

        showComposeFiles() {
            return this.isEditMode || !this.$root.info?.showComposeOnlyInEditMode;
        },

        /**
         * Get the stack from the global stack list, because it may contain more real-time data like status
         * @return {*}
         */
        globalStack() {
            return this.$root.completeStackList[this.stack.name + "_" + this.endpoint];
        },

        status() {
            return this.globalStack?.status ?? this.stack.status;
        },

        active() {
            return this.status === RUNNING;
        },

        terminalName() {
            if (!this.stack.name) {
                return "";
            }
            return getComposeTerminalName(this.endpoint, this.stack.name);
        },

        combinedTerminalName() {
            if (!this.stack.name) {
                return "";
            }
            return getCombinedTerminalName(this.endpoint, this.stack.name);
        },

        networks() {
            return this.jsonConfig.networks;
        },

        endpoint() {
            return this.stack.endpoint || this.$route.params.endpoint || "";
        },

        url() {
            if (this.stack.endpoint) {
                return `/compose/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/compose/${this.stack.name}`;
            }
        },
    },
    watch: {
        "stack.composeOverrideYAML"() {
            this.yamlCodeChange();
        },

        "stack.name"() {
            this.scheduleConfigResolution();
        },

        "stack.endpoint"() {
            this.resolvedConfig = {};
            this.resolvedEditorServices = {};
            this.scheduleConfigResolution();
        },

        "stack.composeYAML": {
            handler() {
                if (this.editorFocus) {
                    console.debug("yaml code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        "stack.composeENV": {
            handler() {
                if (this.editorFocus) {
                    console.debug("env code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        jsonConfig: {
            handler() {
                if (!this.editorFocus && JSON.stringify(this.jsonConfig) !== this.sourceConfigSnapshot) {
                    console.debug("jsonConfig changed");

                    let doc = new Document(this.jsonConfig);

                    // Stick back the yaml comments
                    if (this.yamlDoc) {
                        copyYAMLComments(doc, this.yamlDoc);
                    }

                    this.stack.composeYAML = doc.toString();
                    this.yamlDoc = doc;
                    this.sourceConfigSnapshot = JSON.stringify(this.jsonConfig);
                    this.scheduleConfigResolution();
                }
            },
            deep: true,
        },

        $route(to, from) {

        }
    },
    mounted() {
        if (this.isAdd) {
            this.processing = false;
            this.isEditMode = true;

            let composeYAML;
            let composeENV;

            if (this.$root.composeTemplate) {
                composeYAML = this.$root.composeTemplate;
                this.$root.composeTemplate = "";
            } else {
                composeYAML = template;
            }
            if (this.$root.envTemplate) {
                composeENV = this.$root.envTemplate;
                this.$root.envTemplate = "";
            } else {
                composeENV = envDefault;
            }

            // Default Values
            this.stack = {
                name: "",
                composeYAML,
                composeENV,
                composeOverrideYAML: "",
                isManagedByDockge: true,
                endpoint: "",
            };

            this.yamlCodeChange();

        } else {
            this.stack.name = this.$route.params.stackName;
            this.loadStack();
        }

        this.requestServiceStatus();
        this.requestDockerStats();
    },
    unmounted() {
        this.stopServiceStatusTimeout = true;
        this.serviceStatusRequest++;
        clearTimeout(this.serviceStatusTimeout);
        clearTimeout(this.configTimeout);
        clearTimeout(this.configResponseTimeout);
        clearTimeout(yamlErrorTimeout);
        this.configRequest++;
    },
    methods: {
        setContainerOptions(options) {
            Object.assign(this, options);
        },
        setContainerView(compact) {
            this.compactView = compact;
            localStorage.containerView = compact ? "compact" : "cards";
        },

        startServiceStatusTimeout() {
            clearTimeout(this.serviceStatusTimeout);
            this.serviceStatusTimeout = setTimeout(() => {
                this.requestServiceStatus();
            }, 5000);
        },

        startDockerStatsTimeout() {
            clearTimeout(dockerStatsTimeout);
            dockerStatsTimeout = setTimeout(async () => {
                this.requestDockerStats();
            }, 5000);
        },

        requestServiceStatus() {
            // Do not request if it is add mode
            if (this.isAdd || this.stopServiceStatusTimeout) {
                return;
            }

            const request = ++this.serviceStatusRequest;
            clearTimeout(this.serviceStatusTimeout);
            // A lost acknowledgement must not stop polling forever. Ordinary
            // polls wait for their reply; only this timeout or an explicit
            // action refresh supersedes a request that is still pending.
            this.serviceStatusTimeout = setTimeout(() => {
                this.serviceStatusError = this.$t("Container status request timed out");
                this.requestServiceStatus();
            }, 15000);
            this.$root.emitAgent(this.endpoint, "serviceStatusList", this.stack.name, (res) => {
                if (request !== this.serviceStatusRequest || this.stopServiceStatusTimeout) {
                    return;
                }
                clearTimeout(this.serviceStatusTimeout);
                this.serviceStatusError = res.ok ? "" : res.msg;
                if (res.ok) {
                    this.serviceStatusList = res.serviceStatusList;
                    const errorCount = res.stackErrorCount ?? countContainerIssues(Object.values(res.serviceStatusList).flat());
                    this.stack.errorCount = errorCount;
                    if (this.globalStack) {
                        this.globalStack.errorCount = errorCount;
                    }
                    if (res.stackStatus !== undefined) {
                        this.stack.status = res.stackStatus;
                        if (this.globalStack) {
                            this.globalStack.status = res.stackStatus;
                        }
                    }
                }
                if (!this.stopServiceStatusTimeout) {
                    this.startServiceStatusTimeout();
                }
            });
        },

        requestDockerStats() {
            this.$root.emitAgent(this.endpoint, "dockerStats", (res) => {
                if (res.ok) {
                    this.dockerStats = res.dockerStats;
                }
                if (!this.stopDockerStatsTimeout) {
                    this.startDockerStatsTimeout();
                }
            });
        },

        exitConfirm(next) {
            if (this.isEditMode) {
                if (confirm(this.$t("confirmLeaveStack"))) {
                    this.exitAction();
                    next();
                } else {
                    next(false);
                }
            } else {
                this.exitAction();
                next();
            }
        },

        exitAction() {
            console.log("exitAction");
            this.stopServiceStatusTimeout = true;
            this.serviceStatusRequest++;
            this.stopDockerStatsTimeout = true;
            clearTimeout(this.serviceStatusTimeout);
            clearTimeout(dockerStatsTimeout);
            clearTimeout(this.configTimeout);
            clearTimeout(this.configResponseTimeout);
            this.configRequest++;

            // Leave Combined Terminal
            console.debug("leaveCombinedTerminal", this.endpoint, this.stack.name);
            this.$root.emitAgent(this.endpoint, "leaveCombinedTerminal", this.stack.name, () => {});
        },

        bindTerminal() {
            this.$refs.progressTerminal?.bind(this.endpoint, this.terminalName);
        },

        loadStack() {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, "getStack", this.stack.name, (res) => {
                this.processing = false;
                if (res.ok) {
                    this.stack = res.stack;
                    this.yamlCodeChange();
                    this.bindTerminal();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        deployStack() {
            this.processing = true;

            if (!this.serviceConfig.services) {
                this.$root.toastError("No services found in compose.yaml");
                this.processing = false;
                return;
            }

            // Check if services is object
            if (typeof this.jsonConfig.services !== "object") {
                this.$root.toastError("Services must be an object");
                this.processing = false;
                return;
            }

            let serviceNameList = Object.keys(this.serviceConfig.services);

            // Set the stack name if empty, use the first container name
            if (!this.stack.name && serviceNameList.length > 0) {
                let serviceName = serviceNameList[0];
                let service = this.serviceConfig.services[serviceName];

                if (service && service.container_name) {
                    this.stack.name = service.container_name;
                } else {
                    this.stack.name = serviceName;
                }
            }

            const request = this.beginOperation(false);

            this.$root.emitAgent(this.stack.endpoint, "deployStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, this.stack.composeOverrideYAML || "", (res) => {
                if (!this.finishOperation(request, res)) {
                    return;
                }

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        saveStack() {
            this.processing = true;

            this.$root.emitAgent(this.stack.endpoint, "saveStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, this.stack.composeOverrideYAML || "", (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        startStack() {
            this.runStackOperation("startStack");
        },

        stopStack() {
            this.runStackOperation("stopStack");
        },

        downStack() {
            this.runStackOperation("downStack");
        },

        restartStack() {
            this.runStackOperation("restartStack");
        },

        pullStack() {
            this.runStackOperation("pullStack");
        },

        killStack() {
            this.runStackOperation("killStack");
        },

        beginOperation(stopping) {
            const request = ++this.operationRequest;
            if (stopping) {
                this.serviceOperations = Object.create(null);
            }
            this.processing = true;
            this.stopping = stopping;
            this.operationRunning = true;
            this.showProgressTerminal = true;
            this.bindTerminal();
            this.$nextTick(() => this.$refs.progressTerminal?.updateTerminalSize());
            return request;
        },

        finishOperation(request, res) {
            // Stop supersedes a pending Start. Its late reply must not unlock
            // the controls while shutdown is still running.
            if (request !== this.operationRequest) {
                return false;
            }
            this.processing = false;
            this.stopping = false;
            this.operationRunning = false;
            this.$root.toastRes(res);
            this.requestServiceStatus();
            return true;
        },

        runStackOperation(event) {
            if (this.stopping) {
                return;
            }
            const request = this.beginOperation([ "stopStack", "downStack", "killStack" ].includes(event));
            this.$root.emitAgent(this.endpoint, event, this.stack.name, (res) => {
                this.finishOperation(request, res);
            });
        },

        runServiceOperation(event, serviceName) {
            if (this.stopping || this.serviceOperations[serviceName]
                || (this.processing && !this.operationRunning)) {
                return;
            }
            const request = ++this.serviceOperationRequest;
            this.serviceOperations[serviceName] = request;
            this.showProgressTerminal = true;
            this.bindTerminal();
            this.$nextTick(() => this.$refs.progressTerminal?.updateTerminalSize());
            this.$root.emitAgent(this.endpoint, event, this.stack.name, serviceName, (res) => {
                if (this.serviceOperations[serviceName] !== request) {
                    return;
                }
                delete this.serviceOperations[serviceName];
                this.$root.toastRes(res);
                this.requestServiceStatus();
            });
        },

        deleteDialog() {
            this.$root.emitAgent(this.endpoint, "deleteStack", this.stack.name, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$router.push("/");
                }
            });
        },

        discardStack() {
            this.loadStack();
            this.isEditMode = false;
        },

        yamlToJSON(yaml) {
            let doc = parseComposeDocument(yaml);
            if (doc.errors.length > 0) {
                throw doc.errors[0];
            }

            const config = doc.toJS() ?? {};

            // Check data types
            // "services" must be an object
            if (!config.services) {
                config.services = {};
            }

            if (Array.isArray(config.services) || typeof config.services !== "object") {
                throw new Error("Services must be an object");
            }

            return {
                config,
                doc,
            };
        },

        yamlCodeChange() {
            clearTimeout(yamlErrorTimeout);
            this.yamlError = "";
            this.configError = "";
            this.resolvingConfig = false;
            try {
                let { config, doc } = this.yamlToJSON(this.stack.composeYAML);
                const overrides = this.yamlToJSON(this.stack.composeOverrideYAML || "").config;

                this.yamlDoc = doc;
                this.sourceConfigSnapshot = JSON.stringify(config);
                this.jsonConfig = config;
                this.overrideConfig = overrides;

                let env = dotenv.parse(this.stack.composeENV);
                let envYAML = envsubstYAML(this.stack.composeYAML, env);
                this.envsubstJSONConfig = this.yamlToJSON(envYAML).config;

                this.scheduleConfigResolution();
            } catch (e) {
                clearTimeout(this.configTimeout);
                clearTimeout(this.configResponseTimeout);
                this.configRequest++;
                this.resolvingConfig = false;
                clearTimeout(yamlErrorTimeout);

                yamlErrorTimeout = setTimeout(() => {
                    this.yamlError = e.message;
                }, validationDelay);
            }
        },

        /** Load services immediately when viewing a stack; debounce editor changes. */
        scheduleConfigResolution(delay = this.isEditMode ? validationDelay : 0) {
            clearTimeout(this.configTimeout);
            clearTimeout(this.configResponseTimeout);
            this.configError = "";
            this.resolvingConfig = false;
            const request = ++this.configRequest;
            this.configTimeout = setTimeout(() => {
                this.resolvingConfig = true;
                this.configResponseTimeout = setTimeout(() => {
                    if (request === this.configRequest) {
                        this.resolvingConfig = false;
                        this.configError = this.$t("Compose configuration request timed out");
                    }
                }, 20000);
                this.$root.emitAgent(this.endpoint, "resolveStackConfig", this.stack.name || "", this.stack.composeYAML || "", this.stack.composeENV || "", this.stack.composeOverrideYAML || "", (res) => {
                    if (request !== this.configRequest) {
                        return;
                    }
                    clearTimeout(this.configResponseTimeout);
                    this.resolvingConfig = false;
                    this.configError = res.ok ? "" : res.msg;
                    // Keep the last successful model while a draft is incomplete,
                    // so an unfinished form field does not remove its own card.
                    if (res.ok) {
                        this.resolvedConfig = res.config;
                        this.resolvedEditorServices = Object.fromEntries(Object.entries(this.resolvedConfig.services || {}).map(([ name, service ]) => [ name, editableService(service) ]));
                    }
                });
            }, delay);
        },

        /** Keep inherited edits in local overrides instead of flattening includes. */
        updateService({ name, field, value }) {
            if (!this.jsonConfig.services[name] || Object.hasOwn(this.overrideConfig.services[name] || {}, field)) {
                try {
                    this.stack.composeOverrideYAML = updateOverride(this.stack.composeOverrideYAML || "", name, field, value);
                } catch (e) {
                    this.yamlError = e.message;
                }
            } else {
                this.jsonConfig.services[name][field] = value;
            }
        },

        /** Remove only services declared in the main document. */
        removeService(name) {
            delete this.jsonConfig.services[name];
        },

        enableEditMode() {
            this.isEditMode = true;
        },

        checkYAML() {

        },

        addContainer() {
            this.checkYAML();

            if (this.serviceConfig.services[this.newContainerName]) {
                this.$root.toastError("Container name already exists");
                return;
            }

            if (!this.newContainerName) {
                this.$root.toastError("Container name cannot be empty");
                return;
            }

            this.jsonConfig.services[this.newContainerName] = {
                restart: "unless-stopped",
            };
            this.newContainerName = "";
            let element = this.$refs.containerList.lastElementChild;
            element.scrollIntoView({
                block: "start",
                behavior: "smooth"
            });
        },

        stackNameToLowercase() {
            this.stack.name = this.stack?.name?.toLowerCase();
        },

        buildService(name) {
            this.runServiceOperation("buildService", name);
        },
        downService(name) {
            this.runServiceOperation("downService", name);
        },
        rmService(name) {
            this.runServiceOperation("rmService", name);
        },
        startService(serviceName) {
            this.runServiceOperation("startService", serviceName);
        },

        stopService(serviceName) {
            this.runServiceOperation("stopService", serviceName);
        },

        killService(serviceName) {
            this.runServiceOperation("killService", serviceName);
        },

        pullService(serviceName) {
            this.runServiceOperation("pullService", serviceName);
        },

        restartService(serviceName) {
            this.runServiceOperation("restartService", serviceName);
        },
    }
};
</script>

<style scoped lang="scss">
@import "../styles/vars.scss";

.terminal {
    height: 200px;
}

.editor-box {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
}

.agent-name {
    font-size: 13px;
    color: $dark-font-color3;
}
</style>
