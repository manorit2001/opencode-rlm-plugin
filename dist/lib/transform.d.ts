import type { ChatMessage, RecursiveConfig, RLMFocusedContext, TransformRun } from "./types.js";
export type FocusedContextGenerator = (archiveContext: string, latestGoal: string, config: RecursiveConfig) => Promise<RLMFocusedContext>;
export type DriftDetector = (archiveContext: string, recentContext: string, latestGoal: string, config: RecursiveConfig) => Promise<{
    drifted: boolean;
    score: number;
}>;
export declare function computeFocusedContext(messages: ChatMessage[], config: RecursiveConfig, contextLimitHint: number | null, generator?: FocusedContextGenerator, driftDetector?: DriftDetector): Promise<TransformRun>;
