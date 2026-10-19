<template>
    <div class="container-logs">
        <h1>{{ $t("Logs") }} — {{ serviceName }} ({{ stackName }})</h1>
        <Terminal
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
import Terminal from "../components/Terminal.vue";
import { getContainerLogsTerminalName } from "../../../common/util-common";

export default {
    components: { Terminal },
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

.log-terminal {
    flex: 1;
    min-height: 0;
}
</style>
