<template>
    <section class="images-section mt-4" :class="{ 'drag-active': dragging }" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="dropFiles">
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
            <h2 class="mb-0 me-auto">{{ $t("Images") }}</h2>
            <select v-if="devices.length > 1" v-model="endpoint" class="form-select device-select" :aria-label="$t('Docker device')">
                <option v-for="device in devices" :key="device.endpoint" :value="device.endpoint">
                    {{ device.name }}{{ online(device.endpoint) ? '' : ' (' + $t('Offline') + ')' }}
                </option>
            </select>
            <button class="btn btn-normal" :disabled="!available || loading" @click="load">{{ $t("Refresh") }}</button>
            <button class="btn btn-normal" :disabled="!available" @click="pullDialog = true">{{ $t("Pull") }}</button>
            <button class="btn btn-primary" :disabled="!available" @click="$refs.upload.click()">{{ $t("Upload") }}</button>
            <input ref="upload" type="file" class="visually-hidden" accept=".tar,.tar.gz,.tgz" :aria-label="$t('Upload image archive')" @change="selectFile">
        </div>
        <p class="text-secondary">{{ $t("Drop an image archive here to upload it to the selected device") }}</p>
        <p v-if="!online(endpoint)" class="alert alert-warning">{{ $t("Selected device is offline") }}</p>
        <p v-else-if="!supported" class="alert alert-warning">{{ $t("Update this agent to use image management") }}</p>
        <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
        <input v-model="search" class="form-control mb-3" type="search" :placeholder="$t('Search images by name, tag or ID')" :aria-label="$t('Search images')">
        <div class="form-check form-switch mb-3">
            <input id="hide-untagged-images" v-model="hideUntagged" class="form-check-input" type="checkbox" role="switch">
            <label class="form-check-label" for="hide-untagged-images">{{ $t("Hide untagged images") }}</label>
        </div>
        <div v-if="loading" role="status" class="mb-3">{{ $t("Loading images…") }}</div>
        <p v-else-if="available && !filtered.length">{{ $t("No images found") }}</p>
        <div v-for="image in filtered" :key="image.id" class="shadow-box image-row mb-2">
            <button class="image-summary btn text-start" :aria-expanded="!!expanded[image.id]" @click="expand(image)">
                <span class="image-name">{{ image.tags[0] || $t('Untagged') }} <small v-if="image.tags.length > 1">(+{{ image.tags.length - 1 }})</small></span>
                <code>{{ shortID(image.id) }}</code>
                <span>{{ bytes(image.size) }}</span>
                <span>{{ image.os }}/{{ image.architecture }}</span>
                <span v-if="image.containers.length" class="badge bg-secondary">{{ image.containers.length }} {{ $t("containers") }}</span>
                <font-awesome-icon :icon="expanded[image.id] ? 'chevron-up' : 'chevron-down'" />
            </button>
            <div v-if="expanded[image.id]" class="image-details pt-3">
                <dl>
                    <dt>{{ $t("Image ID") }}</dt><dd><code>{{ image.id }}</code></dd>
                    <dt>{{ $t("Created") }}</dt><dd>{{ date(image.created) }}</dd>
                    <dt>{{ $t("Tags") }}</dt>
                    <dd>
                        <div v-for="tag in image.tags" :key="tag" class="d-flex align-items-center gap-2 mb-1">
                            <code>{{ tag }}</code>
                            <button class="btn btn-sm btn-normal" :disabled="busy[image.id]" :aria-label="$t('Remove tag') + ' ' + tag" @click="removeTag(image, tag)"><font-awesome-icon icon="times" /></button>
                        </div>
                        <span v-if="!image.tags.length">{{ $t("Untagged") }}</span>
                    </dd>
                    <dt>{{ $t("Digests") }}</dt><dd>{{ image.digests.join(', ') || '—' }}</dd>
                    <dt>{{ $t("Used by containers") }}</dt>
                    <dd><div v-for="container in image.containers" :key="container.id">{{ container.name }} ({{ container.state }})</div><span v-if="!image.containers.length">—</span></dd>
                    <dt>{{ $t("Labels") }}</dt><dd><pre>{{ details[image.id] ? JSON.stringify(details[image.id].labels, null, 2) : $t('Loading…') }}</pre></dd>
                </dl>
                <div class="d-flex flex-wrap gap-2">
                    <button class="btn btn-normal" :disabled="busy[image.id]" @click="download(image)">{{ $t("Download") }}</button>
                    <button v-if="hasOnlineAgent && destinations.length > 0" class="btn btn-normal" :disabled="busy[image.id]" @click="openCopy(image)">{{ $t("Copy to…") }}</button>
                    <button class="btn btn-normal" :disabled="busy[image.id]" @click="openTag(image)">{{ $t("Tag") }}</button>
                    <button class="btn btn-danger" :disabled="busy[image.id] || image.containers.length > 0" :title="image.containers.length ? $t('Image is used by containers') : ''" @click="deleteImage(image)">{{ $t("Delete") }}</button>
                </div>
            </div>
        </div>
        <div v-if="jobs.length" class="shadow-box mt-3">
            <h5>{{ $t("Image operations") }}</h5>
            <div v-for="job in jobs" :key="job.id" class="image-job py-2">
                <div class="d-flex flex-wrap align-items-center gap-2">
                    <strong>{{ $t(job.kind) }}: {{ job.label }}</strong>
                    <span class="badge" :class="job.state === 'failed' ? 'bg-danger' : 'bg-secondary'">{{ $t(job.state) }}</span>
                    <button v-if="activeJob(job)" class="btn btn-sm btn-normal ms-auto" @click="cancel(job)">{{ $t("Cancel") }}</button>
                </div>
                <small>{{ deviceName(job.endpoint) }}<template v-if="job.kind === 'copy'"> → {{ deviceName(job.destination) }}</template> · {{ bytes(job.bytes) }}<template v-if="job.total !== undefined"> / {{ bytes(job.total) }}</template></small>
                <div v-if="activeJob(job)" class="progress mt-1" role="progressbar" :aria-label="$t('Image transfer progress')" :aria-valuenow="jobPercent(job) ?? undefined" aria-valuemin="0" aria-valuemax="100">
                    <div class="progress-bar progress-bar-striped progress-bar-animated" :style="{ width: (jobPercent(job) ?? 100) + '%' }">{{ jobPercent(job) === null ? '' : jobPercent(job) + '%' }}</div>
                </div>
                <div class="job-message">{{ job.message }}</div>
            </div>
        </div>
        <BModal v-model="pullDialog" :title="$t('Pull image')" :ok-title="$t('Pull')" :ok-disabled="!reference.trim()" @ok="pull">
            <p>{{ deviceName(endpoint) }}</p>
            <label for="image-pull-reference" class="form-label">{{ $t("Image reference") }}</label>
            <input id="image-pull-reference" v-model="reference" class="form-control" placeholder="registry.example.com/team/image:latest">
            <p class="form-text">{{ $t("Uses this device's existing Docker registry credentials. Existing tags may be updated.") }}</p>
        </BModal>
        <BModal v-model="tagDialog" :title="$t('Tag image')" :ok-title="$t('Tag')" :ok-disabled="!tagReference.trim()" @ok="tag">
            <p>{{ selected?.tags[0] || selected?.id }}</p>
            <label for="image-tag-reference" class="form-label">{{ $t("New image reference") }}</label>
            <input id="image-tag-reference" v-model="tagReference" class="form-control" placeholder="my-image:latest">
        </BModal>
        <BModal v-model="copyDialog" :title="$t('Copy image')" :ok-title="$t('Copy')" :ok-disabled="copyDestination === null" @ok="copy">
            <p>{{ selected?.tags.join(', ') || selected?.id }}</p>
            <p>{{ $t("Source") }}: {{ deviceName(endpoint) }}</p>
            <label for="image-copy-destination" class="form-label">{{ $t("Destination") }}</label>
            <select id="image-copy-destination" v-model="copyDestination" class="form-select">
                <option v-for="device in destinations" :key="device.endpoint" :value="device.endpoint">{{ device.name }}</option>
            </select>
            <p class="form-text">{{ $t("Copies all current tags and available architectures. The source image is kept.") }}</p>
        </BModal>
    </section>
</template>

<script>
import imagesView from "../images-view";
export default imagesView;
</script>

<style scoped lang="scss">
.images-section {
    min-width: 0;
    &.drag-active { outline: 2px dashed #5cdd8b; outline-offset: 8px; }
}
.device-select { width: auto; max-width: 100%; }
.image-summary {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem;
    width: 100%; color: inherit; padding: 0.25rem;
    .image-name { flex: 1 1 16rem; overflow-wrap: anywhere; }
}
.image-details { padding: 0.5rem; overflow-wrap: anywhere; }
dd { margin-bottom: 0.75rem; }
pre { white-space: pre-wrap; }
.image-job + .image-job { border-top: 1px solid #7775; }
.job-message { font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
