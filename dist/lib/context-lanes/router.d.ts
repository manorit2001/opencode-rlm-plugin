import type { RecursiveConfig } from "../types.js";
import type { ContextLane, ContextLaneScore } from "./types.js";
interface LaneSelectionCandidate {
    primaryContextID: string | null;
    secondaryContextIDs: string[];
    scores: ContextLaneScore[];
}
export declare function scoreContextsForMessage(messageText: string, contexts: ContextLane[], now: number): ContextLaneScore[];
export declare function shouldRunSemanticRerank(scores: ContextLaneScore[], config: RecursiveConfig): boolean;
export declare function mergeSemanticScores(scores: ContextLaneScore[], semanticByContextID: Map<string, number>, config: RecursiveConfig): ContextLaneScore[];
export declare function selectContextLanes(scores: ContextLaneScore[], currentPrimaryContextID: string | null, config: RecursiveConfig): LaneSelectionCandidate;
export {};
