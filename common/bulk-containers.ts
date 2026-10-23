export type BulkScope = "managed" | "all";
export interface BulkOptions {
    scope: BulkScope;
    remove: boolean;
}
export interface BulkContainerResult {
    id: string;
    name: string;
    state: "killed" | "removed" | "skipped" | "failed";
    message?: string;
}
export interface BulkJob {
    id: string;
    state: "running" | "completed" | "failed";
    total: number;
    completed: number;
    results: BulkContainerResult[];
    message?: string;
}
export interface BulkPreview {
    token: string;
    count: number;
    protectedCount: number;
    expires: number;
}
