const BRIDGE_HASH_PREFIX = "#comiceerr-download=";
const BRIDGE_TIMEOUT_MS = 30000;

const pendingBridges = new Map();
const trackedDownloads = new Map();
let nextBridgeId = 1;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "searchGetComics") {
        handleSearch(request.comic).then(sendResponse);
        return true;
    }

    if (request.action === "downloadComic") {
        startComicDownload(
            request.postUrl,
            sender.tab && sender.tab.id
        ).then(sendResponse);
        return true;
    }

    if (request.action === "activateNativeDownload") {
        const response = authorizeNativeDownload(
            request.bridgeId,
            request.downloadUrl,
            sender.tab && sender.tab.id
        );
        sendResponse(response);
        return false;
    }

    if (request.action === "nativeDownloadUnavailable") {
        failBridge(
            request.bridgeId,
            sender.tab && sender.tab.id
        );
        sendResponse({ acknowledged: true });
        return false;
    }
});

chrome.downloads.onCreated.addListener((downloadItem) => {
    const bridge = findBridgeForDownload(downloadItem);
    if (!bridge) {
        return;
    }

    trackedDownloads.set(downloadItem.id, {
        leagueTabId: bridge.leagueTabId,
        postUrl: bridge.postUrl
    });

    notifyLeagueTab(bridge.leagueTabId, {
        action: "comicDownloadStarted",
        postUrl: bridge.postUrl
    });
    finishBridge(bridge.id);
});

chrome.downloads.onChanged.addListener((delta) => {
    const tracked = trackedDownloads.get(delta.id);
    if (!tracked) {
        return;
    }

    if (delta.error || (delta.state && delta.state.current === "interrupted")) {
        trackedDownloads.delete(delta.id);
        notifyLeagueTab(tracked.leagueTabId, {
            action: "comicDownloadFailed",
            postUrl: tracked.postUrl
        });
        return;
    }

    if (delta.state && delta.state.current === "complete") {
        trackedDownloads.delete(delta.id);
        notifyLeagueTab(tracked.leagueTabId, {
            action: "comicDownloadComplete",
            postUrl: tracked.postUrl
        });
    }
});

function isTrustedGetComicsUrl(url, requiredPathPrefix = "/") {
    return (
        url.protocol === "https:" &&
        (url.hostname === "getcomics.org" || url.hostname.endsWith(".getcomics.org")) &&
        url.pathname.startsWith(requiredPathPrefix)
    );
}

function decodeHtmlEntities(value) {
    const namedEntities = {
        amp: "&",
        apos: "'",
        hellip: "…",
        laquo: "«",
        ldquo: "“",
        lsquo: "‘",
        mdash: "—",
        ndash: "–",
        quot: '"',
        raquo: "»",
        rdquo: "”",
        rsquo: "’"
    };

    return value
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => (
            String.fromCodePoint(Number.parseInt(code, 16))
        ))
        .replace(/&#(\d+);/g, (_match, code) => (
            String.fromCodePoint(Number.parseInt(code, 10))
        ))
        .replace(/&([a-z]+);/gi, (match, name) => (
            namedEntities[name.toLowerCase()] || match
        ));
}

function normalizeMatchText(value) {
    return decodeHtmlEntities(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeIssueNumber(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^0+(?=\d)/, "");
}

function parseTitleIdentity(title) {
    let cleanTitle = decodeHtmlEntities(title).replace(/\s+/g, " ").trim();
    const yearMatch = cleanTitle.match(
        /\((\d{4})(?:\s*[-–—]\s*(?:\d{4}|present))?\)\s*$/i
    );
    const releaseYear = yearMatch ? Number(yearMatch[1]) : null;

    if (yearMatch) {
        cleanTitle = cleanTitle.slice(0, yearMatch.index).trim();
    }

    const issueMatch = cleanTitle.match(/^(.*?)\s*#\s*([a-z0-9.-]+)\s*$/i);

    return {
        cleanTitle,
        issueNumber: issueMatch ? normalizeIssueNumber(issueMatch[2]) : null,
        releaseYear,
        seriesTitle: issueMatch
            ? normalizeMatchText(issueMatch[1])
            : normalizeMatchText(cleanTitle)
    };
}

function extractSearchCandidates(searchText, searchUrl) {
    const candidates = [];
    const headingRegex = /<h[1-2]\b[^>]*class=["'][^"']*\bpost-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-2]>/gi;
    let headingMatch;

    while ((headingMatch = headingRegex.exec(searchText)) !== null) {
        const headingHtml = headingMatch[1];
        const linkMatch = headingHtml.match(
            /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
        );

        if (!linkMatch) {
            continue;
        }

        const postUrl = new URL(
            linkMatch[1].replace(/&amp;/gi, "&"),
            searchUrl
        );
        if (!isTrustedGetComicsUrl(postUrl)) {
            continue;
        }

        const title = decodeHtmlEntities(
            linkMatch[2].replace(/<[^>]+>/g, " ")
        ).replace(/\s+/g, " ").trim();

        candidates.push({
            ...parseTitleIdentity(title),
            postUrl: postUrl.href,
            title
        });
    }

    return candidates;
}

function findMatchingPost(candidates, comic) {
    if (!comic || typeof comic.title !== "string") {
        return null;
    }

    const target = parseTitleIdentity(comic.title);
    const targetIssue = normalizeIssueNumber(
        comic.issueNumber || target.issueNumber
    );
    const targetSeries = normalizeMatchText(
        comic.seriesTitle || target.seriesTitle
    );
    const targetYear = Number(comic.releaseYear) || null;

    const matchingUrls = new Set(
        candidates
            .filter((candidate) => {
                if (candidate.seriesTitle !== targetSeries) {
                    return false;
                }

                if (targetIssue && candidate.issueNumber !== targetIssue) {
                    return false;
                }

                if (!targetIssue &&
                    normalizeMatchText(candidate.cleanTitle) !==
                    normalizeMatchText(target.cleanTitle)) {
                    return false;
                }

                return !(
                    targetYear &&
                    candidate.releaseYear &&
                    targetYear !== candidate.releaseYear
                );
            })
            .map((candidate) => candidate.postUrl)
    );

    return matchingUrls.size === 1
        ? Array.from(matchingUrls)[0]
        : null;
}

async function handleSearch(comic) {
    try {
        if (!comic || typeof comic.title !== "string" || !comic.title.trim()) {
            return { found: false };
        }

        const query = comic.title.replace(/#/g, " ");
        const searchUrl = `https://getcomics.org/?s=${encodeURIComponent(query)}`;
        const searchRes = await fetch(searchUrl);

        if (!searchRes.ok) {
            throw new Error(`GetComics search returned HTTP ${searchRes.status}`);
        }

        const searchText = await searchRes.text();
        const candidates = extractSearchCandidates(searchText, searchUrl);
        const postUrl = findMatchingPost(candidates, comic);

        return postUrl
            ? { found: true, postUrl }
            : { found: false };
    } catch (error) {
        console.error("Error connecting to GetComics:", error);
        return { found: false };
    }
}

function startComicDownload(postUrlValue, leagueTabId) {
    return new Promise((resolve) => {
        let postUrl;

        try {
            postUrl = new URL(postUrlValue);
        } catch {
            resolve({ started: false, error: "invalid_url" });
            return;
        }

        if (!isTrustedGetComicsUrl(postUrl)) {
            resolve({ started: false, error: "untrusted_url" });
            return;
        }

        const bridgeId = `${Date.now()}-${nextBridgeId++}`;
        const bridgeUrl = new URL(postUrl.href);
        bridgeUrl.hash = `${BRIDGE_HASH_PREFIX.slice(1)}${encodeURIComponent(bridgeId)}`;

        chrome.tabs.create(
            {
                url: bridgeUrl.href,
                active: false
            },
            (tab) => {
                if (
                    chrome.runtime.lastError ||
                    !tab ||
                    typeof tab.id !== "number"
                ) {
                    resolve({ started: false, error: "background_tab_failed" });
                    return;
                }

                const bridge = {
                    clickedAt: null,
                    downloadUrl: null,
                    id: bridgeId,
                    leagueTabId,
                    postUrl: postUrl.href,
                    tabId: tab.id,
                    timeoutId: null
                };

                bridge.timeoutId = setTimeout(() => {
                    if (!pendingBridges.has(bridgeId)) {
                        return;
                    }

                    notifyLeagueTab(leagueTabId, {
                        action: "comicDownloadFailed",
                        postUrl: postUrl.href
                    });
                    finishBridge(bridgeId);
                }, BRIDGE_TIMEOUT_MS);

                pendingBridges.set(bridgeId, bridge);
                resolve({ started: true, bridgeId });
            }
        );
    });
}

function authorizeNativeDownload(bridgeId, downloadUrlValue, senderTabId) {
    const bridge = pendingBridges.get(bridgeId);
    if (!bridge || bridge.tabId !== senderTabId) {
        return { allowed: false };
    }

    let downloadUrl;
    try {
        downloadUrl = new URL(downloadUrlValue);
    } catch {
        failBridge(bridgeId, senderTabId);
        return { allowed: false };
    }

    if (!isTrustedGetComicsUrl(downloadUrl, "/dls/")) {
        failBridge(bridgeId, senderTabId);
        return { allowed: false };
    }

    bridge.downloadUrl = downloadUrl.href;
    bridge.clickedAt = Date.now();
    return { allowed: true };
}

function findBridgeForDownload(downloadItem) {
    const candidates = Array.from(pendingBridges.values())
        .filter((bridge) => bridge.clickedAt !== null)
        .sort((left, right) => left.clickedAt - right.clickedAt);

    const exactMatch = candidates.find((bridge) => (
        downloadItem.url === bridge.downloadUrl ||
        downloadItem.finalUrl === bridge.downloadUrl
    ));

    if (exactMatch) {
        return exactMatch;
    }

    const referrerMatch = candidates.find((bridge) => (
        typeof downloadItem.referrer === "string" &&
        downloadItem.referrer.startsWith(bridge.postUrl)
    ));

    if (referrerMatch) {
        return referrerMatch;
    }

    // A redirected DownloadItem can expose only the final comicfiles.ru URL.
    // If there is one pending native click, it is the unambiguous source.
    return candidates.length === 1 ? candidates[0] : null;
}

function failBridge(bridgeId, senderTabId) {
    const bridge = pendingBridges.get(bridgeId);
    if (!bridge || bridge.tabId !== senderTabId) {
        return;
    }

    notifyLeagueTab(bridge.leagueTabId, {
        action: "comicDownloadFailed",
        postUrl: bridge.postUrl
    });
    finishBridge(bridgeId);
}

function finishBridge(bridgeId) {
    const bridge = pendingBridges.get(bridgeId);
    if (!bridge) {
        return;
    }

    pendingBridges.delete(bridgeId);
    clearTimeout(bridge.timeoutId);

    chrome.tabs.remove(bridge.tabId, () => {
        // Reading lastError suppresses the warning if the tab already closed.
        void chrome.runtime.lastError;
    });
}

function notifyLeagueTab(tabId, message) {
    if (typeof tabId !== "number") {
        return;
    }

    chrome.tabs.sendMessage(tabId, message, () => {
        // Reading lastError suppresses the expected warning if the page closed.
        void chrome.runtime.lastError;
    });
}
