import type { RecursiveConfig } from "../types.js";
import type { ContextLane, ContextLaneScore } from "./types.js";
type FetchLike = typeof fetch;
export declare function computeSemanticSimilaritiesForTopCandidates(latestUserText: string, scores: ContextLaneScore[], contextByID: Map<string, ContextLane>, config: RecursiveConfig, fetchImpl?: FetchLike): Promise<Map<string, number>>;
export {};
