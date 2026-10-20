<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveGeneral">
            <!-- Client side Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Display Timezone") }}
                </label>
                <select id="timezone" v-model="$root.userTimezone" class="form-select">
                    <option value="auto">
                        {{ $t("Auto") }}: {{ guessTimezone }}
                    </option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Server Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Server Timezone") }}
                </label>
                <select id="timezone" v-model="settings.serverTimezone" class="form-select">
                    <option value="UTC">UTC</option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Primary Hostname -->
            <div class="mb-4">
                <label class="form-label" for="primaryBaseURL">
                    {{ $t("primaryHostname") }}
                </label>

                <div class="input-group mb-3">
                    <input
                        v-model="settings.primaryHostname"
                        class="form-control"
                        :placeholder="$t(`CurrentHostname`)"
                    />
                    <button class="btn btn-outline-primary" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <div class="form-text"></div>
            </div>

            <div class="form-check form-switch mb-4">
                <input id="show-only-managed-stacks" v-model="settings.showOnlyManagedStacks" class="form-check-input" type="checkbox" role="switch" :disabled="!settingsLoaded" />
                <label class="form-check-label" for="show-only-managed-stacks">{{ $t("Show only Dockge-managed stacks") }}</label>
            </div>

            <div class="form-check form-switch mb-4">
                <input id="compose-only-in-edit-mode" v-model="settings.showComposeOnlyInEditMode" class="form-check-input" type="checkbox" role="switch" :disabled="!settingsLoaded" />
                <label class="form-check-label" for="compose-only-in-edit-mode">{{ $t("Show Compose / Overrides only in edit mode") }}</label>
            </div>

            <div class="form-check form-switch mb-4">
                <input id="agent-friendly-names" v-model="settings.showAgentFriendlyNames" class="form-check-input" type="checkbox" role="switch" :disabled="!settingsLoaded" />
                <label class="form-check-label" for="agent-friendly-names">{{ $t("Show friendly agent names instead of IP:port") }}</label>
            </div>

            <div class="mb-4">
                <label for="ignored-container-exit-codes" class="form-label">{{ $t("Ignored container exit codes") }}</label>
                <input id="ignored-container-exit-codes" v-model="ignoredExitCodesInput" class="form-control" type="text" placeholder="137, 143" :disabled="!settingsLoaded" aria-describedby="ignored-exit-codes-help" />
                <div id="ignored-exit-codes-help" class="form-text">{{ $t("Separate exit codes with commas. Leave empty to flag all nonzero exits. Confirmed OOM kills remain errors. Applies to stacks on this device.") }}</div>
            </div>

            <!-- Save Button -->
            <div>
                <button class="btn btn-primary" type="submit">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>

import dayjs from "dayjs";
import { timezoneList } from "../../util-frontend";

export default {
    components: {

    },

    data() {
        return {
            timezoneList: timezoneList(),
        };
    },

    computed: {
        ignoredExitCodesInput: {
            get() {
                const value = this.settings.ignoredContainerExitCodes;
                return Array.isArray(value) ? value.join(", ") : value || "";
            },
            set(value) {
                this.settings.ignoredContainerExitCodes = value;
            },
        },
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        guessTimezone() {
            return dayjs.tz.guess();
        }
    },

    methods: {
        /** Save the settings */
        saveGeneral() {
            localStorage.timezone = this.$root.userTimezone;
            this.saveSettings();
        },
        /** Get the base URL of the application */
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },
    },
};
</script>

