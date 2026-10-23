<template>
    <div class="mb-3">
        <button class="btn btn-danger" @click="open">{{ $t("Kill all") }}</button>
        <BModal v-model="show" :title="$t('Kill all')" hide-footer :no-close-on-backdrop="running || busy">
            <fieldset :disabled="running || busy">
                <label class="form-label" for="bulk-scope">{{ $t("Container scope") }}</label>
                <select id="bulk-scope" v-model="scope" class="form-select mb-3">
                    <option value="managed">{{ $t("Dockge-managed containers") }}</option>
                    <option value="all">{{ $t("All containers") }}</option>
                </select>
                <label class="form-check mb-3"><input v-model="remove" type="checkbox" class="form-check-input"> {{ $t("Also remove containers") }}</label>
                <p class="small text-secondary">{{ $t("Dockge instances are protected. Images, volumes, networks and Compose files are kept.") }}</p>
                <div class="d-flex gap-2 mb-3">
                    <button type="button" class="btn btn-sm btn-normal" @click="selectAll">{{ $t("Select all online agents") }}</button>
                    <button type="button" class="btn btn-sm btn-normal" @click="selected = []">{{ $t("Clear selection") }}</button>
                    <button type="button" class="btn btn-sm btn-normal" @click="refreshPreviews">{{ $t("Refresh") }}</button>
                </div>
                <div v-for="device in devices" :key="device.endpoint" class="mb-3">
                    <label class="form-check">
                        <input v-model="selected" type="checkbox" class="form-check-input" :value="device.endpoint" :disabled="(!device.online || !device.supported) && !selected.includes(device.endpoint)">
                        {{ device.name }} <small v-if="!device.online">({{ $t('Offline') }})</small><small v-else-if="!device.supported">({{ $t('Update agent') }})</small>
                    </label>
                    <div v-if="selected.includes(device.endpoint)" class="small ms-4">
                        <span v-if="previews[device.endpoint]">{{ $t("Affected") }}: {{ previews[device.endpoint].count }} · {{ $t("Protected Dockge instances") }}: {{ previews[device.endpoint].protectedCount }}</span>
                        <span v-else-if="!errors[device.endpoint] && !jobs[device.endpoint]">{{ $t("Loading…") }}</span>
                    </div>
                </div>
                <button class="btn btn-danger" :disabled="!canRun" @click="execute">{{ $t(remove ? 'Kill and remove' : 'Kill') }}</button>
            </fieldset>
            <div v-for="device in devices.filter(device => jobs[device.endpoint] || errors[device.endpoint])" :key="device.endpoint" class="mt-3">
                <h6>{{ device.name }}</h6>
                <p v-if="errors[device.endpoint]" class="text-danger">{{ $t(errors[device.endpoint]) }}</p>
                <template v-if="jobs[device.endpoint]">
                    <p class="mb-1">{{ $t(jobs[device.endpoint].state) }} · {{ jobs[device.endpoint].completed }} / {{ jobs[device.endpoint].total }}</p>
                    <progress class="w-100" :max="Math.max(1, jobs[device.endpoint].total)" :value="jobs[device.endpoint].completed" />
                    <details v-if="jobs[device.endpoint].results.length">
                        <summary>{{ $t("Container results") }}</summary>
                        <div v-for="result in jobs[device.endpoint].results" :key="result.id" :class="result.state === 'failed' ? 'text-danger' : ''">{{ result.name }}: {{ $t(result.state) }}<span v-if="result.message"> — {{ $t(result.message) }}</span></div>
                    </details>
                    <p v-if="jobs[device.endpoint].message" class="text-danger">{{ jobs[device.endpoint].message }}</p>
                </template>
            </div>
            <button v-if="Object.keys(jobs).length && !running" class="btn btn-normal mt-3" @click="clearFinished">{{ $t("Clear completed") }}</button>
        </BModal>
    </div>
</template>
<script>
import view from "../bulk-containers-view";
export default view;
</script>
