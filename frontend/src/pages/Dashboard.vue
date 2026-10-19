<template>
    <div ref="dashboard" class="container-fluid dashboard-layout" :class="{ 'sidebar-open': sidebarVisible, 'sidebar-collapsed': sidebarAvailable && sidebarCollapsed, 'resizing-sidebar': resizingSidebar }" :style="{ '--sidebar-width': sidebarDisplayWidth + 'px' }">
        <aside v-show="sidebarVisible" id="stack-sidebar" class="stack-sidebar">
            <div class="sidebar-toolbar mb-3">
                <router-link to="/compose" class="btn btn-primary"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
                <button ref="hideSidebar" type="button" class="btn btn-sm btn-normal" :title="$t('Hide stack sidebar')" :aria-label="$t('Hide stack sidebar')" aria-controls="stack-sidebar" :aria-expanded="true" @click="toggleSidebar">
                    <font-awesome-icon icon="chevron-circle-right" class="collapse-icon" />
                </button>
            </div>
            <StackList :scrollbar="true" />
        </aside>

        <div
            v-if="sidebarVisible"
            class="sidebar-divider"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            :aria-label="$t('Resize stack sidebar')"
            aria-controls="stack-sidebar"
            :aria-valuemin="sidebarMinWidth"
            :aria-valuemax="sidebarMaxWidth"
            :aria-valuenow="sidebarDisplayWidth"
            @pointerdown="startSidebarResize"
            @lostpointercapture="stopSidebarResize"
            @keydown="resizeSidebarWithKeyboard"
        ></div>
        <div v-else-if="sidebarAvailable" class="sidebar-rail">
            <button ref="showSidebar" type="button" class="btn btn-sm btn-normal" :title="$t('Show stack sidebar')" :aria-label="$t('Show stack sidebar')" aria-controls="stack-sidebar" :aria-expanded="false" @click="toggleSidebar">
                <font-awesome-icon icon="list" />
            </button>
        </div>

        <div ref="container" class="dashboard-content mb-3">
            <!-- Add :key to disable vue router re-use the same component -->
            <router-view :key="$route.fullPath" :calculatedHeight="height" />
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

export default {
    components: {
        StackList,
    },
    data() {
        const savedWidth = Number(localStorage.stackSidebarWidth);
        return {
            height: 0,
            sidebarCollapsed: localStorage.stackSidebarCollapsed === "true",
            sidebarWidth: Number.isFinite(savedWidth) && savedWidth >= 180 ? savedWidth : 280,
            viewportWidth: window.innerWidth,
            layoutWidth: window.innerWidth,
            resizingSidebar: false,
            resizePointerId: null,
            resizeHandle: null,
            resizeStartX: 0,
            resizeStartWidth: 0,
        };
    },
    computed: {
        sidebarAvailable() {
            return !this.$root.isMobile && this.viewportWidth >= 768;
        },
        sidebarVisible() {
            return this.sidebarAvailable && !this.sidebarCollapsed;
        },
        sidebarMinWidth() {
            return 180;
        },
        sidebarMaxWidth() {
            return Math.max(this.sidebarMinWidth, Math.min(600, Math.floor(this.layoutWidth / 2)));
        },
        sidebarDisplayWidth() {
            return this.clampSidebarWidth(this.sidebarWidth);
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
        this.measureLayout();
        window.addEventListener("resize", this.measureLayout);
    },
    beforeUnmount() {
        this.stopSidebarResize();
        window.removeEventListener("resize", this.measureLayout);
    },
    methods: {
        clampSidebarWidth(width) {
            return Math.round(Math.max(this.sidebarMinWidth, Math.min(this.sidebarMaxWidth, width)));
        },
        measureLayout() {
            if (window.innerWidth < 768) {
                this.stopSidebarResize();
            }
            this.viewportWidth = window.innerWidth;
            this.layoutWidth = this.$refs.dashboard.getBoundingClientRect().width;
        },
        toggleSidebar() {
            this.stopSidebarResize();
            this.sidebarCollapsed = !this.sidebarCollapsed;
            localStorage.stackSidebarCollapsed = String(this.sidebarCollapsed);
            this.$nextTick(() => {
                (this.sidebarCollapsed ? this.$refs.showSidebar : this.$refs.hideSidebar)?.focus();
            });
        },
        startSidebarResize(event) {
            if (event.button !== 0 || event.isPrimary === false || !this.sidebarVisible || this.resizingSidebar) {
                return;
            }
            event.preventDefault();
            this.resizeStartX = event.clientX;
            this.resizeStartWidth = this.sidebarDisplayWidth;
            this.resizePointerId = event.pointerId;
            this.resizeHandle = event.currentTarget;
            this.resizeHandle.setPointerCapture(event.pointerId);
            this.resizingSidebar = true;
            window.addEventListener("pointermove", this.resizeSidebar);
            window.addEventListener("pointerup", this.stopSidebarResize);
            window.addEventListener("pointercancel", this.stopSidebarResize);
            window.addEventListener("blur", this.stopSidebarResize);
        },
        resizeSidebar(event) {
            if (this.resizingSidebar && event.pointerId === this.resizePointerId) {
                this.sidebarWidth = this.clampSidebarWidth(this.resizeStartWidth + event.clientX - this.resizeStartX);
            }
        },
        stopSidebarResize(event) {
            if (!this.resizingSidebar || (event?.pointerId !== undefined && event.pointerId !== this.resizePointerId)) {
                return;
            }
            const handle = this.resizeHandle;
            const pointerId = this.resizePointerId;
            this.resizingSidebar = false;
            this.resizeHandle = null;
            this.resizePointerId = null;
            window.removeEventListener("pointermove", this.resizeSidebar);
            window.removeEventListener("pointerup", this.stopSidebarResize);
            window.removeEventListener("pointercancel", this.stopSidebarResize);
            window.removeEventListener("blur", this.stopSidebarResize);
            if (handle?.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }
            localStorage.stackSidebarWidth = String(this.sidebarDisplayWidth);
        },
        resizeSidebarWithKeyboard(event) {
            const widths = {
                ArrowLeft: this.sidebarDisplayWidth - 16,
                ArrowRight: this.sidebarDisplayWidth + 16,
                Home: this.sidebarMinWidth,
                End: this.sidebarMaxWidth,
            };
            if (Object.hasOwn(widths, event.key)) {
                event.preventDefault();
                this.sidebarWidth = this.clampSidebarWidth(widths[event.key]);
                localStorage.stackSidebarWidth = String(this.sidebarWidth);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.container-fluid {
    width: 98%;
}

.dashboard-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;

    &.sidebar-open {
        grid-template-columns: var(--sidebar-width) 16px minmax(0, 1fr);
    }

    &.sidebar-collapsed {
        grid-template-columns: 40px minmax(0, 1fr);
    }

    &.resizing-sidebar {
        cursor: col-resize;
        user-select: none;
    }
}

.stack-sidebar,
.dashboard-content {
    min-width: 0;
}

.stack-sidebar,
.sidebar-rail {
    align-self: stretch;
}

.sidebar-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}

.collapse-icon {
    transform: rotate(180deg);
}

.sidebar-rail button {
    position: sticky;
    top: 10px;
    padding: 0.35rem 0.5rem;
}

.sidebar-divider {
    cursor: col-resize;
    align-self: stretch;
    position: relative;
    touch-action: none;
    min-height: calc(100vh - 160px);

    &::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 7px;
        width: 2px;
        background: rgba(128, 128, 128, 0.3);
    }

    &:hover::after,
    &:focus-visible::after,
    .resizing-sidebar &::after {
        background: #74c2ff;
    }
}
</style>
