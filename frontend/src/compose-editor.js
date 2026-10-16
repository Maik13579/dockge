import { parseDocument } from "yaml";

/** Recognize Compose's merge tags while retaining their YAML nodes. */
export function parseComposeDocument(source) {
    return parseDocument(source, {
        customTags: [ "!override", "!reset" ].flatMap(tag => [
            { tag,
                collection: "seq",
                resolve: value => value },
            { tag,
                collection: "map",
                resolve: value => value },
            { tag,
                resolve: value => tag === "!reset" ? null : value },
        ]),
    });
}

/** Convert simple canonical Compose values for the existing short-syntax forms. */
export function editableService(config) {
    const service = JSON.parse(JSON.stringify(config));
    if (service.environment && !Array.isArray(service.environment)) {
        service.environment = Object.entries(service.environment).map(([ key, value ]) => value === null ? key : `${key}=${value}`);
    }
    if (service.ports) {
        service.ports = service.ports.map(port => {
            if (typeof port !== "object" || Object.keys(port).some(key => ![ "target", "published", "protocol", "host_ip", "mode" ].includes(key)) || (port.mode && port.mode !== "ingress")) {
                return port;
            }
            const host = port.host_ip ? `${port.host_ip.includes(":") ? `[${port.host_ip}]` : port.host_ip}:` : "";
            return `${port.published ? `${host}${port.published}:` : ""}${port.target}/${port.protocol || "tcp"}`;
        });
    }
    if (service.volumes) {
        service.volumes = service.volumes.map(volume => {
            if (typeof volume !== "object" || Object.keys(volume).some(key => ![ "type", "source", "target", "read_only", "bind", "volume" ].includes(key)) || ![ "bind", "volume" ].includes(volume.type)) {
                return volume;
            }
            if ((volume.bind && Object.entries(volume.bind).some(([ key, value ]) => key !== "create_host_path" || value !== true)) || (volume.volume && Object.keys(volume.volume).length)) {
                return volume;
            }
            return `${volume.source ? `${volume.source}:` : ""}${volume.target}${volume.read_only ? ":ro" : ""}`;
        });
    }
    if (service.networks && !Array.isArray(service.networks) && Object.values(service.networks).every(options => !options || Object.keys(options).length === 0)) {
        service.networks = Object.keys(service.networks);
    }
    if (service.depends_on && !Array.isArray(service.depends_on) && Object.values(service.depends_on).every(options => options.condition === "service_started" && options.required !== false && !options.restart)) {
        service.depends_on = Object.keys(service.depends_on);
    }
    return service;
}

/** Update only the edited field and preserve the override document's comments/tags. */
export function updateOverride(source, name, field, value) {
    const doc = parseComposeDocument(source);
    if (doc.errors.length) {
        throw doc.errors[0];
    }
    const node = doc.createNode(value);
    // A form edits the complete list/map. Ordinary Compose merging would retain
    // removed ports, mounts or environment entries from the included service.
    if (value !== null && typeof value === "object") {
        node.tag = "!override";
    }
    doc.setIn([ "services", name, field ], node);
    return doc.toString();
}
