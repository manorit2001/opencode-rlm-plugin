function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
function normalizeText(input) {
    return input.replace(/\s+/g, " ").trim();
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
    catch (error) {
        if (process.env.RLM_PLUGIN_DEBUG === "1") {
            console.error("RLM semantic lane rerank /api/embed failed", error);
        }
    }
    const vectors = [];
    for (const text of texts) {
        const payload = await postJSON(`${baseURL}/api/embeddings`, {
            model: config.driftEmbeddingModel,
            prompt: text,
        }, config.driftEmbeddingTimeoutMs, fetchImpl);
        const vector = parseEmbeddings(payload)[0];
        if (!vector) {
            throw new Error("Ollama lane semantic response did not include a valid embedding vector");
        }
        vectors.push(vector);
    }
    return vectors;
}
function laneSemanticText(context, config) {
    const merged = normalizeText(`${context.title}\n${context.summary}`);
    return clipForEmbedding(merged, config.driftEmbeddingMaxChars);
}
export async function computeSemanticSimilaritiesForTopCandidates(latestUserText, scores, contextByID, config, fetchImpl = fetch) {
    const result = new Map();
    if (!config.laneSemanticEnabled || config.driftEmbeddingProvider.toLowerCase() !== "ollama") {
        return result;
    }
    const topCandidates = scores.slice(0, config.laneSemanticTopK);
    if (topCandidates.length < 2) {
        return result;
    }
    const queryText = clipForEmbedding(normalizeText(latestUserText), config.driftEmbeddingMaxChars);
    if (queryText.length === 0) {
        return result;
    }
    const laneTexts = [];
    const laneIDs = [];
    for (const candidate of topCandidates) {
        const context = contextByID.get(candidate.contextID);
        if (!context) {
            continue;
        }
        const text = laneSemanticText(context, config);
        if (text.length === 0) {
            continue;
        }
        laneTexts.push(text);
        laneIDs.push(context.id);
    }
    if (laneTexts.length < 2) {
        return result;
    }
    let vectors;
    try {
        vectors = await embedWithOllama([queryText, ...laneTexts], config, fetchImpl);
    }
    catch (error) {
        if (process.env.RLM_PLUGIN_DEBUG === "1") {
            console.error("RLM semantic lane rerank failed, falling back to lexical", error);
        }
        return result;
    }
    const queryVector = vectors[0];
    if (!queryVector) {
        return result;
    }
    for (let index = 0; index < laneIDs.length; index += 1) {
        const laneVector = vectors[index + 1];
        if (!laneVector) {
            continue;
        }
        const similarity = cosineSimilarity(queryVector, laneVector);
        result.set(laneIDs[index], clamp01((similarity + 1) / 2));
    }
    return result;
}
