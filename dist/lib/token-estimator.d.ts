import type { ChatMessage } from "./types.js";
export declare function estimatePartTokens(part: Record<string, unknown>): number;
export declare function estimateMessageTokens(message: ChatMessage): number;
export declare function estimateConversationTokens(messages: ChatMessage[]): number;
