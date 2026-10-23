<template>
    <div class="d-flex align-items-center flex-wrap gap-2">
        <select :value="columns" class="form-select form-select-sm list-option" :aria-label="$t('Columns')" @change="change({ containerColumns: Number($event.target.value) })">
            <option v-for="count in 4" :key="count" :value="count">{{ $t('Columns') }}: {{ count }}</option>
        </select>
        <select :value="sort" class="form-select form-select-sm list-option" :aria-label="$t('Sort containers')" @change="change({ containerSort: $event.target.value, containerDirection: ['cpu', 'memory'].includes($event.target.value) ? 'desc' : 'asc' })">
            <option value="status">{{ $t('Status') }}</option>
            <option value="name">{{ $t('Name') }}</option>
            <option value="cpu">{{ $t('CPU') }}</option>
            <option value="memory">{{ $t('Memory') }}</option>
        </select>
        <button type="button" class="btn btn-sm btn-normal" :title="$t('Sort direction')" :aria-label="$t('Sort direction')" @click="change({ containerDirection: direction === 'asc' ? 'desc' : 'asc' })">{{ direction === 'asc' ? '↑' : '↓' }}</button>
        <slot />
    </div>
</template>
<script>
export default {
    props: { columns: { type: Number,
        default: 1 },
    sort: { type: String,
        default: "status" },
    direction: { type: String,
        default: "asc" } },
    emits: [ "change" ],
    methods: {
        change(options) {
            for (const [ key, value ] of Object.entries(options)) {
                localStorage[key] = value;
            }
            this.$emit("change", options);
        },
    },
};
</script>
<style scoped>
.list-option { width: auto; }
</style>
