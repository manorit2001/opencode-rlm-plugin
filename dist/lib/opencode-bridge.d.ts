import type { RecursiveConfig, RLMFocusedContext } from "./types.js";
export declare const INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG = "[RLM_INTERNAL_FOCUSED_CONTEXT_PROMPT]";
interface SessionClientLike {
    create: (input: {
        body?: {
            parentID?: string;
            title?: string;
        };
    }) => Promise<unknown>;
    prompt: (input: {
        path: {
            id: string;
        };
        body?: {
            model?: {
                providerID: string;
                modelID: string;
            };
            parts: Array<{
                type: "text";
                text: string;
            }>;
        };
    }) => Promise<unknown>;
    delete: (input: {
        path: {
            id: string;
        };
    }) => Promise<unknown>;
}
export interface OpencodeClientLike {
    session: SessionClientLike;
}
export interface OpenCodeBridgeInput {
    client: OpencodeClientLike;
    sessionID: string;
    archiveContext: string;
    latestGoal: string;
    config: RecursiveConfig;
}
export declare function generateFocusedContextWithOpenCodeAuth(input: OpenCodeBridgeInput): Promise<RLMFocusedContext>;
export {};
