const ZERO_SIMILARITIES = {
    goalToArchive: 0,
    goalToRecent: 0,
    archiveToRecent: 0,
};
function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
function cosineSimilarity(left, right) {
    const length = Math.min(left.length, right.length);
    if (length === 0) {
        return 0;
    }
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < length; index += 1) {
        const l = left[index];
        const r = right[index];
        dot += l * r;
        leftNorm += l * l;
        rightNorm += r * r;
    }
    if (leftNorm === 0 || rightNorm === 0) {
        return 0;
    }
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
function clipForEmbedding(input, maxChars) {
    if (input.length <= maxChars) {
        return input;
    }
    const half = Math.floor((maxChars - 5) / 2);
    if (half <= 0) {
        return input.slice(0, maxChars);
    }
    return `${input.slice(0, half)}\n...\n${input.slice(input.length - half)}`;
}
function normalizeText(input) {
    return input.replace(/\s+/g, " ").trim();
}
function isNumberArray(input) {
    return Array.isArray(input) && input.every((value) => typeof value === "number");
}
function parseEmbeddings(payload) {
    if (!payload || typeof payload !== "object") {
        return [];
    }
    const record = payload;
    if (Array.isArray(record.embeddings)) {
        if (record.embeddings.length === 0) {
            return [];
        }
        if (isNumberArray(record.embeddings)) {
            return [record.embeddings];
        }
        return record.embeddings.filter(isNumberArray);
    }
    if (isNumberArray(record.embedding)) {
        return [record.embedding];
    }
    return [];
}
async function postJSON(url, body, timeoutMs, fetchImpl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
async function embedWithOllama(texts, config, fetchImpl) {
    const baseURL = config.driftEmbeddingBaseURL.replace(/\/+$/, "");
    try {
        const payload = await postJSON(`${baseURL}/api/embed`, {
            model: config.driftEmbeddingModel,
            input: texts,
        }, config.driftEmbeddingTimeoutMs, fetchImpl);
        const vectors = parseEmbeddings(payload);
        if (vectors.length === texts.length) {
            return vectors;
        }
    }
    catch { }
    const vectors = [];
    for (const text of texts) {
        const payload = await postJSON(`${baseURL}/api/embeddings`, {
            model: config.driftEmbeddingModel,
            prompt: text,
        }, config.driftEmbeddingTimeoutMs, fetchImpl);
        const vector = parseEmbeddings(payload)[0];
        if (!vector) {
            throw new Error("Ollama drift embedding response did not include a valid embedding vector");
        }
        vectors.push(vector);
    }
    return vectors;
}
export function computeDriftScore(similarities) {
    const goalShift = clamp01((similarities.goalToArchive - similarities.goalToRecent) / 0.45);
    const recentMismatch = clamp01((0.55 - similarities.goalToRecent) / 0.55);
    const archiveRecentGap = clamp01((0.6 - similarities.archiveToRecent) / 0.6);
    return clamp01(0.6 * goalShift + 0.25 * recentMismatch + 0.15 * archiveRecentGap);
}
export async function detectContextDriftWithEmbeddings(archiveContext, recentContext, latestGoal, config, fetchImpl = fetch) {
    if (!config.driftEmbeddingsEnabled) {
        return { drifted: false, score: 0, similarities: ZERO_SIMILARITIES };
    }
    if (config.driftEmbeddingProvider.toLowerCase() !== "ollama") {
        return { drifted: false, score: 0, similarities: ZERO_SIMILARITIES };
    }
    const goal = clipForEmbedding(normalizeText(latestGoal), config.driftEmbeddingMaxChars);
    const recent = clipForEmbedding(normalizeText(recentContext), config.driftEmbeddingMaxChars);
    const archive = clipForEmbedding(normalizeText(archiveContext), config.driftEmbeddingMaxChars);
    if (goal.length === 0 || recent.length === 0 || archive.length === 0) {
        return { drifted: false, score: 0, similarities: ZERO_SIMILARITIES };
    }
    const vectors = await embedWithOllama([goal, recent, archive], config, fetchImpl);
    if (vectors.length < 3) {
        throw new Error("Drift detector did not receive expected embedding vectors");
    }
    const similarities = {
        goalToArchive: cosineSimilarity(vectors[0], vectors[2]),
        goalToRecent: cosineSimilarity(vectors[0], vectors[1]),
        archiveToRecent: cosineSimilarity(vectors[2], vectors[1]),
    };
    const score = computeDriftScore(similarities);
    const drifted = score >= config.driftThreshold && similarities.goalToArchive > similarities.goalToRecent;
    return {
        drifted,
        score,
        similarities,
    };
}
