export interface GroupAgent {
    endpoint: string;
    name: string;
}

export interface GroupMember {
    reference: string;
    agentName: string;
    endpoint: string;
    stackName: string;
    error?: string;
}

export function splitGroupReference(reference: unknown) {
    if (typeof reference !== "string" || reference.length > 400) {
        throw new Error("Invalid stack group member");
    }
    const separator = reference.lastIndexOf(":");
    const agent = reference.slice(0, separator).trim();
    const stackName = reference.slice(separator + 1);
    if (separator < 1 || !agent || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(stackName) || [ ".", ".." ].includes(stackName)) {
        throw new Error("Use Agent:Stack for each group member");
    }
    return { agent,
        stackName };
}

/** References are interpreted exclusively in the owning agent's directory. */
export function resolveGroupMember(reference: string, agents: GroupAgent[]): GroupMember {
    const { agent, stackName } = splitGroupReference(reference);
    if (agent === "Current") {
        return { reference,
            agentName: "Current",
            endpoint: "",
            stackName };
    }
    const direct = agents.find(item => item.endpoint === agent);
    const matches = direct ? [ direct ] : agents.filter(item => item.name?.trim() === agent);
    if (matches.length !== 1) {
        throw new Error(matches.length ? `Agent name is ambiguous: ${agent}` : `Agent not found: ${agent}`);
    }
    return { reference,
        agentName: matches[0].name?.trim() || matches[0].endpoint,
        endpoint: matches[0].endpoint,
        stackName };
}

/** A namespaced endpoint keeps terminal routing isolated across owners and stacks. */
export function stackGroupEndpoint(owner: string, group: string, member: string): string {
    return "stack-group:" + encodeURIComponent(JSON.stringify([ owner, group, member ]));
}

export function parseStackGroupEndpoint(endpoint: string) {
    if (!endpoint?.startsWith("stack-group:")) {
        return null;
    }
    try {
        const value = JSON.parse(decodeURIComponent(endpoint.slice("stack-group:".length)));
        if (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "string")) {
            return { owner: value[0],
                group: value[1],
                member: value[2] };
        }
    } catch {
        // Ordinary endpoints never pass through group routing.
    }
    return null;
}
