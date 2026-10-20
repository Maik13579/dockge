<template>
    <div>
        <h1 class="mb-3">{{ isAdd ? $t("Add stack group") : name }} <small class="group-owner">{{ $root.endpointDisplayFunction(owner) }}</small></h1>
        <div v-if="error" class="alert alert-warning" role="alert">{{ error }}</div>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <template v-if="editing">
                <button class="btn btn-primary" :disabled="saving || !name.trim()" @click="save">{{ $t("Save group") }}</button>
                <button class="btn btn-normal" :disabled="saving" @click="discard">{{ $t("discardStack") }}</button>
            </template>
            <template v-else>
                <button class="btn btn-secondary" :disabled="processing" @click="edit">{{ $t("Edit group") }}</button>
                <button class="btn btn-primary" :disabled="processing || !members.length" @click="runGroupOperation('startStack')">{{ $t("Up") }}</button>
                <button class="btn btn-normal" :disabled="processing || !members.length" @click="runGroupOperation('restartStack')">{{ $t("restartStack") }}</button>
                <button class="btn btn-normal" :disabled="processing || !members.length" @click="runGroupOperation('pullStack')">{{ $t("Pull") }}</button>
                <button class="btn btn-normal" :disabled="stopping || !members.length" @click="runGroupOperation('stopStack')">{{ $t("stopStack") }}</button>
                <BDropdown right text="" variant="normal">
                    <BDropdownItem :disabled="stopping" @click="runGroupOperation('stopStack')">{{ $t("stopStack") }}</BDropdownItem>
                    <BDropdownItem :disabled="stopping" @click="runGroupOperation('downStack')">{{ $t("Down") }}</BDropdownItem>
                    <BDropdownItem :disabled="stopping" @click="runGroupOperation('killStack')">{{ $t("Kill") }}</BDropdownItem>
                </BDropdown>
                <button class="btn btn-normal" @click="refresh">{{ $t("Refresh") }}</button>
                <button class="btn btn-danger" :disabled="processing" @click="remove">{{ $t("Delete group") }}</button>
            </template>
        </div>
        <div v-if="editing" class="shadow-box big-padding">
            <label for="group-name" class="form-label">{{ $t("Stack group name") }}</label>
            <input id="group-name" v-model="name" class="form-control mb-3" maxlength="100">
            <template v-if="isAdd">
                <label for="group-owner" class="form-label">{{ $t("Group owner") }}</label>
                <select id="group-owner" v-model="owner" class="form-select mb-3">
                    <option v-for="(agent, endpoint) in $root.agentList" :key="endpoint" :value="endpoint" :disabled="$root.agentStatusList[endpoint] !== 'online'">{{ $root.endpointDisplayFunction(endpoint) }}</option>
                </select>
            </template>
            <div class="d-flex align-items-center gap-2 mb-3">
                <input v-model="choiceSearch" type="search" class="form-control" :placeholder="$t('Search stacks')">
                <button class="btn btn-normal" @click="loadOptions">{{ $t("Refresh") }}</button>
            </div>
            <p v-if="optionsError" class="text-warning">{{ optionsError }}</p>
            <div v-for="choice in choices" :key="choice.endpoint" class="mb-3">
                <h5>{{ choice.agentName }} <small v-if="choice.endpoint" class="text-secondary">{{ choice.endpoint }}</small></h5>
                <p v-if="choice.error" class="text-warning">{{ choice.error }}</p>
                <label v-for="stack in choice.stacks.filter(stack => matchesChoice(choice, stack))" :key="stack.reference" class="d-flex align-items-center gap-2 mb-2">
                    <input v-model="selected" class="form-check-input" type="checkbox" :value="stack.reference">
                    {{ stack.name }}
                </label>
            </div>
            <label v-for="reference in missingSelections" :key="reference" class="d-flex align-items-center gap-2 mb-2 text-warning">
                <input v-model="selected" class="form-check-input" type="checkbox" :value="reference">{{ reference }} ({{ $t("Unavailable") }})
            </label>
        </div>
        <template v-else>
            <p role="status">{{ $t(groupState) }} · {{ members.length }} {{ $t("Stacks") }} · {{ rows.length }} {{ $t("containers") }}</p>
            <div v-if="loading" role="status">{{ $t("Loading…") }}</div>
            <div v-for="member in members.filter(member => member.error || member.configError)" :key="member.reference" class="text-warning mb-2">{{ member.agentName }} / {{ member.stackName }}: {{ member.error || member.configError }}</div>
            <div v-if="results.length" class="shadow-box mb-3">
                <div v-for="result in results" :key="result.reference" :class="result.ok ? 'text-success' : 'text-danger'">{{ result.reference }}: {{ result.ok ? $t("Completed") : result.msg }}</div>
            </div>
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h4 class="mb-0">{{ $t("Containers") }}</h4>
                <div class="btn-group" role="group" :aria-label="$t('Container view')">
                    <button class="btn btn-sm btn-normal" :class="{ active: !compactView }" :aria-pressed="!compactView" @click="setContainerView(false)">{{ $t("Cards") }}</button>
                    <button class="btn btn-sm btn-normal" :class="{ active: compactView }" :aria-pressed="compactView" @click="setContainerView(true)">{{ $t("Compact") }}</button>
                </div>
            </div>
            <div v-for="row in rows" :key="row.key">
                <div class="small text-secondary mb-1">{{ row.member.agentName }} / {{ row.member.stackName }} <span v-if="row.member.error">({{ $t("Unavailable") }})</span></div>
                <Container
                    :name="row.name" :context="containerContext(row)" :compact="compactView" :service-status="row.member.serviceStatusList?.[row.name]" :docker-stats="row.member.dockerStats || {}"
                    @start-service="runServiceOperation('startService', row)" @stop-service="runServiceOperation('stopService', row)"
                    @kill-service="runServiceOperation('killService', row)" @restart-service="runServiceOperation('restartService', row)" @pull-service="runServiceOperation('pullService', row)"
                />
            </div>
            <template v-if="selectedMember">
                <div class="d-flex align-items-center gap-2 mb-3">
                    <h4 class="mb-0">{{ $t("terminal") }}</h4>
                    <select v-model="terminalMember" class="form-select terminal-select" :aria-label="$t('Stack terminal')">
                        <option v-for="member in members.filter(member => member.stack)" :key="member.reference" :value="member.reference">{{ member.agentName }} / {{ member.stackName }}</option>
                    </select>
                </div>
                <Terminal :key="progressTerminalName" class="mb-3 group-progress" :name="progressTerminalName" :endpoint="terminalEndpoint" :rows="8" />
                <Terminal :key="combinedTerminalName" class="mb-3 group-logs" :name="combinedTerminalName" :endpoint="terminalEndpoint" :rows="15" />
            </template>
        </template>
    </div>
</template>

<script>
import Container from "../components/Container.vue";
import Terminal from "../components/Terminal.vue";
import view from "../stack-groups-view";
export default { ...view,
    components: { Container,
        Terminal } };
</script>

<style scoped lang="scss">
.group-owner { font-size: 0.9rem; color: #888; }
.terminal-select { width: auto; max-width: 100%; }
.group-progress { height: 180px; }
.group-logs { height: 315px; }
</style>
