import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isMap, isScalar, parseDocument } from "yaml";
import { splitGroupReference } from "../common/stack-groups";

export class StackGroups {
    private writing: Promise<unknown> = Promise.resolve();
    constructor(private directory: string) {}

    private validateName(name: unknown): asserts name is string {
        if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.length > 100 || /[/\\\x00-\x1f]/.test(name)) {
            throw new Error("Invalid stack group name");
        }
    }

    private async document() {
        let source = "";
        try {
            source = await fs.readFile(path.join(this.directory, "groups.yaml"), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        const doc = parseDocument(source);
        if (doc.errors.length) {
            throw new Error(`groups.yaml: ${doc.errors[0].message}`);
        }
        const data = doc.toJS() ?? {};
        if (typeof data !== "object" || Array.isArray(data)) {
            throw new Error("groups.yaml must map group names to lists of stacks");
        }
        for (const [ name, members ] of Object.entries(data)) {
            this.validateName(name);
            this.validateMembers(members);
        }
        return { doc,
            data: data as Record<string, string[]> };
    }

    private validateMembers(members: unknown): asserts members is string[] {
        if (!Array.isArray(members) || members.length > 200 || members.some(member => typeof member !== "string")) {
            throw new Error("A stack group must contain a list of at most 200 stacks");
        }
        members.forEach(splitGroupReference);
        if (new Set(members).size !== members.length) {
            throw new Error("A stack may only appear once in a group");
        }
    }

    async list() {
        return (await this.document()).data;
    }

    async get(name: unknown) {
        this.validateName(name);
        const groups = await this.list();
        if (!Object.hasOwn(groups, name)) {
            throw new Error("Stack group not found");
        }
        return groups[name];
    }

    /** Serialize edits and replace atomically, preserving other groups/comments. */
    private edit(change: (document: Awaited<ReturnType<StackGroups["document"]>>) => void) {
        const operation = this.writing.catch(() => {}).then(async () => {
            const document = await this.document();
            change(document);
            const temporary = path.join(this.directory, `.groups-${randomUUID()}.yaml`);
            try {
                await fs.writeFile(temporary, document.doc.toString(), { mode: 0o600,
                    flag: "wx" });
                await fs.rename(temporary, path.join(this.directory, "groups.yaml"));
            } finally {
                await fs.rm(temporary, { force: true });
            }
        });
        this.writing = operation;
        return operation;
    }

    async save(name: unknown, members: unknown, original?: unknown) {
        this.validateName(name);
        this.validateMembers(members);
        if (original !== undefined) {
            this.validateName(original);
        }
        await this.edit(({ doc, data }) => {
            if (original !== name && Object.hasOwn(data, name)) {
                throw new Error("Stack group already exists");
            }
            if (original !== undefined && !Object.hasOwn(data, original)) {
                throw new Error("Stack group not found");
            }
            if (original !== undefined && original !== name) {
                if (isMap(doc.contents)) {
                    const pair = doc.contents.items.find(item => isScalar(item.key) && item.key.value === original);
                    if (pair && isScalar(pair.key)) {
                        pair.key.value = name;
                    }
                }
            }
            doc.set(name, members);
        });
    }

    async delete(name: unknown) {
        this.validateName(name);
        await this.edit(({ doc, data }) => {
            if (!Object.hasOwn(data, name)) {
                throw new Error("Stack group not found");
            }
            doc.delete(name);
        });
    }
}
