import type { ChatMessage, RecursiveConfig, RLMFocusedContext, TransformRun } from "./types.js";
export type FocusedContextGenerator = (archiveContext: string, latestGoal: string, config: RecursiveConfig) => Promise<RLMFocusedContext>;
export declare function computeFocusedContext(messages: ChatMessage[], config: RecursiveConfig, contextLimitHint: number | null, generator?: FocusedContextGenerator): Promise<TransformRun>;
