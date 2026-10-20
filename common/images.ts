export interface ImageContainer {
    id: string;
    name: string;
    image: string;
    state: string;
}

export interface DockerImageSummary {
    id: string;
    tags: string[];
    digests: string[];
    size: number;
    created: string;
    os: string;
    architecture: string;
    containers: ImageContainer[];
}

export interface DockerImageDetails extends DockerImageSummary {
    labels: Record<string, string>;
}

export interface ImageJob {
    id: string;
    kind: "upload" | "download" | "copy" | "pull";
    endpoint: string;
    destination?: string;
    label: string;
    state: "pending" | "preparing" | "transferring" | "loading" | "running" | "completed" | "failed" | "cancelled";
    bytes: number;
    total?: number;
    message: string;
}

export interface ImageRequest {
    action: "list" | "inspect" | "delete" | "tag" | "untag" | "pull" | "download" | "upload" | "copy" | "cancel";
    endpoint: string;
    id?: string;
    reference?: string;
    destination?: string;
    confirmed?: boolean;
    filename?: string;
    size?: number;
    jobId?: string;
}

export interface ImageResult {
    ok?: boolean;
    msg?: string;
    images?: DockerImageSummary[];
    image?: DockerImageDetails;
    ticket?: string;
    conflicts?: string[];
    confirmationRequired?: boolean;
    job?: ImageJob;
}
