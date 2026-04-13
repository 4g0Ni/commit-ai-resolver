/**
 * Detect Azure DevOps work item URLs in a message string.
 * Extracts work item IDs and returns a cleaned message.
 */

const WORKITEM_URL_PATTERN = /https?:\/\/(?:dev\.azure\.com\/msasg|msasg\.visualstudio\.com)\/[^/]+\/_workitems\/edit\/(\d+)[^\s)]*/gi;

/**
 * @param {string} message - User message that may contain work item URLs
 * @returns {{ workItemIds: number[], cleanedMessage: string }}
 */
export function detectWorkItemUrls(message) {
    const workItemIds = [];
    let cleanedMessage = message;

    const matches = [...message.matchAll(WORKITEM_URL_PATTERN)];
    for (const match of matches) {
        const id = parseInt(match[1], 10);
        if (!workItemIds.includes(id)) {
            workItemIds.push(id);
        }
        cleanedMessage = cleanedMessage.replace(match[0], `[Bug ${id}]`);
    }

    return { workItemIds, cleanedMessage: cleanedMessage.trim() };
}
