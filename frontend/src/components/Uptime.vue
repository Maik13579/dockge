<template>
    <span :class="className" :title="errorTitle">{{ statusName }}</span>
</template>

<script>
import { statusColor, statusNameShort } from "../../../common/util-common";

export default {
    props: {
        stack: {
            type: Object,
            default: null,
        },
        fixedWidth: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        uptime() {
            return this.$t("notAvailableShort");
        },

        errorTitle() {
            return this.stack?.errorCount > 0 ? this.$t("Containers need attention") + ": " + this.stack.errorCount : "";
        },

        color() {
            if (this.stack?.errorCount > 0) {
                return "danger";
            }
            return statusColor(this.stack?.status);
        },

        statusName() {
            if (this.stack?.errorCount > 0) {
                return this.$t("Error");
            }
            return this.$t(statusNameShort(this.stack?.status));
        },

        className() {
            let className = `badge rounded-pill bg-${this.color}`;

            if (this.fixedWidth) {
                className += " fixed-width";
            }
            return className;
        },
    },
};
</script>

<style scoped>
.badge {
    min-width: 62px;

}

.fixed-width {
    width: 62px;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
