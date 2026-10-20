<template>
    <div class="container-logs">
        <div class="log-header">
            <h1>{{ $t("Logs") }} — {{ serviceName }} ({{ stackName }})</h1>
            <div class="log-tools">
                <router-link :to="stackRoute" class="btn btn-normal">{{ $t("Back") }}</router-link>
                <div class="input-group log-search" role="search" :aria-label="$t('Search logs')">
                    <input
                        v-model="searchQuery"
                        type="search"
                        class="form-control"
                        :placeholder="$t('Search logs')"
                        :aria-label="$t('Search logs')"
                        @input="searchLogs(false, true)"
                        @keydown.enter.prevent="searchLogs($event.shiftKey)"
                        @keydown.esc.prevent="clearSearch"
                    />
                    <button type="button" class="btn btn-normal" :disabled="!searchQuery" :title="$t('Previous match')" :aria-label="$t('Previous match')" @click="searchLogs(true)">
                        <font-awesome-icon icon="chevron-up" />
                    </button>
                    <button type="button" class="btn btn-normal" :disabled="!searchQuery" :title="$t('Next match')" :aria-label="$t('Next match')" @click="searchLogs()">
                        <font-awesome-icon icon="chevron-down" />
                    </button>
                </div>
                <span class="search-status small text-secondary" role="status">{{ searchQuery && !searchFound ? $t("No matches") : "" }}</span>
            </div>
        </div>
        <Terminal
            ref="logs"
            :key="terminalName"
            class="log-terminal"
            mode="containerLogs"
            :name="terminalName"
            :stack-name="stackName"
            :service-name="serviceName"
            :endpoint="endpoint"
        ></Terminal>
    </div>
</template>

<script>
import { parseStackGroupEndpoint } from "../../../common/stack-groups";
import Terminal from "../components/Terminal.vue";
import { getContainerLogsTerminalName } from "../../../common/util-common";

export default {
    components: { Terminal },
    data() {
        return {
            searchQuery: "",
            searchFound: false,
        };
    },
    computed: {
        stackName() {
            return this.$route.params.stackName;
        },
        serviceName() {
            return this.$route.params.serviceName;
        },
        endpoint() {
            return this.$route.params.endpoint || "";
        },
        terminalName() {
            return getContainerLogsTerminalName(this.endpoint, this.stackName, this.serviceName);
        },
        stackRoute() {
            const group = parseStackGroupEndpoint(this.endpoint);
            if (group) {
                return `/stack-group/${encodeURIComponent(group.group)}${group.owner ? "/" + encodeURIComponent(group.owner) : ""}`;
            }
            const path = `/compose/${encodeURIComponent(this.stackName)}`;
            return this.endpoint ? `${path}/${encodeURIComponent(this.endpoint)}` : path;
        },
    },
    methods: {
        searchLogs(backwards = false, restart = false) {
            this.searchFound = this.$refs.logs?.findText(this.searchQuery, { backwards,
                restart }) || false;
        },
        clearSearch() {
            this.searchQuery = "";
            this.searchLogs(false, true);
        },
    },
};
</script>

<style scoped lang="scss">
.container-logs {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    padding: 1rem;
    gap: 0.75rem;

    h1 {
        flex-shrink: 0;
        font-size: 1.25rem;
        margin: 0;
        overflow-wrap: anywhere;
    }
}

.log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
}

.log-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-left: auto;
    max-width: 100%;
}

.log-search {
    width: 20rem;
    max-width: 100%;
}

.search-status {
    width: 5.5rem;
    min-height: 1.5em;
}

.log-terminal {
    flex: 1;
    min-height: 0;
}
</style>
