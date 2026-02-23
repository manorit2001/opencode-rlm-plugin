import { createServer } from "node:http";
import { renderLaneVisualizationHTML } from "./visualization.js";
function normalizeBasePath(basePath) {
    const trimmed = (basePath ?? "/").trim();
    if (trimmed.length === 0 || trimmed === "/") {
        return "/";
    }
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    const withoutTrailingSlash = withLeadingSlash.endsWith("/")
        ? withLeadingSlash.slice(0, Math.max(1, withLeadingSlash.length - 1))
        : withLeadingSlash;
    return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}
function parsePositiveInt(raw, fallback) {
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(1, Math.floor(parsed));
}
function parseNonNegativeInt(raw, fallback) {
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(0, Math.floor(parsed));
}
function optionsFromQuery(url, defaults) {
    const sessionID = (url.searchParams.get("sessionID") ?? defaults.sessionID).trim();
    return {
        sessionID: sessionID.length > 0 ? sessionID : undefined,
        sessionLimit: parsePositiveInt(url.searchParams.get("sessionLimit"), defaults.sessionLimit),
        contextLimit: parsePositiveInt(url.searchParams.get("contextLimit"), defaults.contextLimit),
        switchLimit: parsePositiveInt(url.searchParams.get("switchLimit"), defaults.switchLimit),
        membershipLimit: parsePositiveInt(url.searchParams.get("membershipLimit"), defaults.membershipLimit),
    };
}
function isRoute(pathname, route) {
    if (pathname === route) {
        return true;
    }
    return route !== "/" && pathname === `${route}/`;
}
function writeJSON(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload, null, 2));
}
function writeText(res, statusCode, contentType, body) {
    res.statusCode = statusCode;
    res.setHeader("content-type", contentType);
    res.end(body);
}
function routeRequest(req, res, defaults, buildSnapshot, listEventsAfter, getMessageDebug, basePath) {
    if (req.method !== "GET") {
        writeJSON(res, 405, { error: "method-not-allowed" });
        return;
    }
    const requestURL = new URL(req.url ?? "/", "http://127.0.0.1");
    const apiPath = basePath === "/" ? "/api/snapshot" : `${basePath}/api/snapshot`;
    const eventsPath = basePath === "/" ? "/api/events" : `${basePath}/api/events`;
    const messagePath = basePath === "/" ? "/api/message" : `${basePath}/api/message`;
    const healthPath = basePath === "/" ? "/health" : `${basePath}/health`;
    if (isRoute(requestURL.pathname, healthPath)) {
        writeJSON(res, 200, {
            ok: true,
            basePath,
            apiPath,
            eventsPath,
            messagePath,
            generatedAt: Date.now(),
        });
        return;
    }
    if (isRoute(requestURL.pathname, apiPath)) {
        const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults));
        writeJSON(res, 200, snapshot);
        return;
    }
    if (isRoute(requestURL.pathname, eventsPath)) {
        const fallbackSessionID = defaults.sessionID.trim();
        const sessionID = (requestURL.searchParams.get("sessionID") ?? fallbackSessionID).trim();
        if (sessionID.length === 0) {
            writeJSON(res, 400, { error: "sessionID-required" });
            return;
        }
        const afterSeq = parseNonNegativeInt(requestURL.searchParams.get("afterSeq"), 0);
        const limit = parsePositiveInt(requestURL.searchParams.get("limit"), 100);
        const events = listEventsAfter(sessionID, afterSeq, limit);
        const lastSeq = events.length > 0 ? events[events.length - 1]?.seq ?? afterSeq : afterSeq;
        writeJSON(res, 200, {
            sessionID,
            afterSeq,
            count: events.length,
            lastSeq,
            events,
        });
        return;
    }
    if (isRoute(requestURL.pathname, messagePath)) {
        const fallbackSessionID = defaults.sessionID.trim();
        const sessionID = (requestURL.searchParams.get("sessionID") ?? fallbackSessionID).trim();
        const messageID = (requestURL.searchParams.get("messageID") ?? "").trim();
        if (sessionID.length === 0 || messageID.length === 0) {
            writeJSON(res, 400, { error: "sessionID-and-messageID-required" });
            return;
        }
        const limit = parsePositiveInt(requestURL.searchParams.get("limit"), 120);
        const data = getMessageDebug(sessionID, messageID, limit);
        writeJSON(res, 200, {
            sessionID,
            messageID,
            ...data,
        });
        return;
    }
    if (isRoute(requestURL.pathname, basePath)) {
        const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults));
        const html = renderLaneVisualizationHTML(snapshot, { apiPath, eventsPath, messagePath });
        writeText(res, 200, "text/html; charset=utf-8", html);
        return;
    }
    writeJSON(res, 404, {
        error: "not-found",
        basePath,
        routes: [basePath, apiPath, eventsPath, messagePath, healthPath],
    });
}
async function listen(server, host, port) {
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
    });
}
async function closeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
export async function startLaneVisualizationWebServer(options) {
    const host = options.host.trim().length > 0 ? options.host.trim() : "127.0.0.1";
    const port = Math.max(0, Math.floor(options.port));
    const basePath = normalizeBasePath(options.basePath);
    const server = createServer((req, res) => {
        routeRequest(req, res, options.defaults, options.buildSnapshot, options.listEventsAfter, options.getMessageDebug, basePath);
    });
    await listen(server, host, port);
    const address = server.address();
    if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error("Lane visualization server failed to resolve listening address");
    }
    const boundHost = address.address === "::" ? "127.0.0.1" : address.address;
    const boundPort = address.port;
    const root = basePath === "/" ? "" : basePath;
    return {
        host: boundHost,
        port: boundPort,
        basePath,
        url: `http://${boundHost}:${boundPort}${root}`,
        close: () => closeServer(server),
    };
}
