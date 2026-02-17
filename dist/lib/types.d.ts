export type GenericRecord = Record<string, unknown>;
export type ChatPart = GenericRecord;
export interface ChatMessage extends GenericRecord {
    id?: string;
    role?: string;
    parts?: ChatPart[];
}
export interface ModelLimits {
    context?: number;
}
export interface ModelInfo {
    limit?: ModelLimits;
}
export interface MessagesTransformInput {
    sessionID?: string;
    model?: ModelInfo;
}
export interface MessagesTransformOutput {
    messages?: ChatMessage[];
    system?: string[];
}
export interface RecursiveConfig {
    enabled: boolean;
    pressureThreshold: number;
    deepPressureThreshold: number;
    deepGoalMinChars: number;
    keepRecentMessages: number;
    maxArchiveChars: number;
    maxFocusedContextChars: number;
    pythonBin: string;
    backend: string;
    model: string;
    environment: string;
    opencodeProviderID?: string;
    opencodeModelID?: string;
    shallowMaxDepth: number;
    shallowMaxIterations: number;
    maxDepth: number;
    maxIterations: number;
    timeoutMs: number;
}
export interface RLMFocusedContext {
    focusedContext: string;
}
export interface TransformRun {
    compacted: boolean;
    focusedContext: string | null;
    tokenEstimate: number;
    pressure: number;
}
