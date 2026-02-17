import type { RecursiveConfig } from "./types.js";
interface DriftSimilarities {
    goalToArchive: number;
    goalToRecent: number;
    archiveToRecent: number;
}
export interface DriftAssessment {
    drifted: boolean;
    score: number;
    similarities: DriftSimilarities;
}
type FetchLike = typeof fetch;
export declare function computeDriftScore(similarities: DriftSimilarities): number;
export declare function detectContextDriftWithEmbeddings(archiveContext: string, recentContext: string, latestGoal: string, config: RecursiveConfig, fetchImpl?: FetchLike): Promise<DriftAssessment>;
export {};
