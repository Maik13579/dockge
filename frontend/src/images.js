const uploads = new Map();

export function imageRequest(root, request) {
    return new Promise((resolve, reject) => {
        root.getSocket().timeout(30000).emit("imageRequest", request, (error, result) => {
            if (error || !result?.ok) {
                reject(new Error(error ? "Image request timed out" : result?.msg || "Image request failed"));
            } else {
                resolve(result);
            }
        });
    });
}

export function updateImageJob(root, job) {
    root.imageJobs[job.id] = { ...root.imageJobs[job.id],
        ...job };
    const finished = Object.values(root.imageJobs).filter(item => item.state === "completed");
    for (const old of finished.slice(0, Math.max(0, finished.length - 5))) {
        delete root.imageJobs[old.id];
    }
}

export function restoreImageJobs(root, jobs) {
    const previous = root.imageJobs;
    root.imageJobs = Object.fromEntries(jobs.filter(job => job.state !== "completed").map(job => [ job.id, { ...previous[job.id],
        ...job }]));
}

export function imageJobPercent(job) {
    if (!job.total || job.state !== "transferring") {
        return null;
    }
    return Math.min(100, Math.floor((job.uploaded || job.bytes) / job.total * 100));
}

export async function uploadArchive(root, endpoint, file) {
    const result = await imageRequest(root, { action: "upload",
        endpoint,
        filename: file.name,
        size: file.size,
        confirmed: true });
    const id = result.job.id;
    updateImageJob(root, { ...result.job,
        total: file.size });
    let ticket = result.ticket;
    let offset = 0;
    try {
        do {
            if ([ "cancelled", "failed" ].includes(root.imageJobs[id]?.state)) {
                throw new Error("Image upload cancelled");
            }
            const end = Math.min(file.size, offset + 8 * 1024 * 1024);
            const final = end === file.size;
            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                uploads.set(id, xhr);
                xhr.open("POST", `/api/image-transfers/${encodeURIComponent(ticket)}`);
                xhr.setRequestHeader("Content-Type", "application/octet-stream");
                xhr.setRequestHeader("X-Image-Final", final ? "1" : "0");
                xhr.responseType = "json";
                xhr.upload.onprogress = event => {
                    const job = root.imageJobs[id];
                    if (job) {
                        job.uploaded = offset + event.loaded;
                    }
                };
                xhr.onload = () => xhr.status === 200 && xhr.response?.ok ? resolve(xhr.response)
                    : reject(new Error(xhr.response?.msg || "Image upload failed"));
                xhr.onerror = () => reject(new Error("Image upload connection failed"));
                xhr.onabort = () => reject(new Error("Image upload cancelled"));
                xhr.send(file.slice(offset, end));
            });
            offset = end;
            ticket = response.ticket;
            if (final) {
                break;
            }
            if (typeof ticket !== "string") {
                throw new Error("Upload chunk was not acknowledged");
            }
        } while (offset < file.size);
    } catch (error) {
        imageRequest(root, { action: "cancel",
            endpoint: "",
            jobId: id }).catch(() => {});
        throw error;
    } finally {
        uploads.delete(id);
    }
}

export function cancelUpload(id) {
    uploads.get(id)?.abort();
}

export function disconnectImages(root) {
    uploads.forEach(xhr => xhr.abort());
    uploads.clear();
    for (const job of Object.values(root.imageJobs)) {
        if (job.kind === "upload" && job.state !== "loading" && ![ "completed", "failed", "cancelled" ].includes(job.state)) {
            job.state = "cancelled";
            job.message = "Upload interrupted; select the archive again to restart it";
        }
    }
}
