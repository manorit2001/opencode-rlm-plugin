const CHARS_PER_TOKEN = 4;
function partText(part) {
    const text = part.text;
    if (typeof text === "string") {
        return text;
    }
    const input = part.input;
    if (typeof input === "string") {
        return input;
    }
    if (input && typeof input === "object") {
        return JSON.stringify(input);
    }
    const output = part.output;
    if (typeof output === "string") {
        return output;
    }
    if (output && typeof output === "object") {
        return JSON.stringify(output);
    }
    return JSON.stringify(part);
}
export function estimatePartTokens(part) {
    const raw = partText(part);
    return Math.max(1, Math.ceil(raw.length / CHARS_PER_TOKEN));
}
export function estimateMessageTokens(message) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return parts.reduce((sum, part) => {
        if (!part || typeof part !== "object") {
            return sum;
        }
        return sum + estimatePartTokens(part);
    }, 0);
}
export function estimateConversationTokens(messages) {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}
