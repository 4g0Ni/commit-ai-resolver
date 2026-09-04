import { wrapToolWithHarness } from './tool-middleware.js';

/** Registry that makes each agent's least-privilege tool set explicit. */
export class ToolRegistry {
    constructor() {
        this.entries = [];
    }

    register({ tool, caller, ...policy }) {
        if (!caller) throw new Error('Tool registration requires a caller agent name.');
        if (this.entries.some(entry => entry.caller === caller && entry.tool.name === tool.name)) {
            throw new Error(`Duplicate tool registration: ${caller}:${tool.name}`);
        }
        this.entries.push({
            caller,
            tool: wrapToolWithHarness(tool, { caller, ...policy }),
        });
        return this;
    }

    toolsFor(caller) {
        return this.entries.filter(entry => entry.caller === caller).map(entry => entry.tool);
    }

    permissionSnapshot() {
        const result = {};
        for (const { caller, tool } of this.entries) {
            if (!result[caller]) result[caller] = [];
            result[caller].push(tool.name);
        }
        return result;
    }

    attachPermissions(context) {
        const snapshot = this.permissionSnapshot();
        context.allowedTools = Object.fromEntries(Object.entries(snapshot)
            .map(([caller, toolNames]) => [caller, new Set(toolNames)]));
        return context;
    }
}

