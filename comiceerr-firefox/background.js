const BRIDGE_HASH_PREFIX = "#comiceerr-download=";
const BRIDGE_TIMEOUT_MS = 30000;

const pendingBridges = new Map();
const trackedDownloads = new Map();
let nextBridgeId = 1;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "searchGetComics") {
        handleSearch(request.query).then(sendResponse);
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

async function handleSearch(query) {
    try {
        const searchUrl = `https://getcomics.org/?s=${encodeURIComponent(query)}`;
        const searchRes = await fetch(searchUrl);

        if (!searchRes.ok) {
            throw new Error(`GetComics search returned HTTP ${searchRes.status}`);
        }

        const searchText = await searchRes.text();
        const postLinkRegex = /<h[1-2][^>]*class=["'][^"']*\bpost-title\b[^"']*["'][^>]*>\s*<a[^>]*href=["']([^"']+)["']/i;
        const match = searchText.match(postLinkRegex);

        if (!match) {
            return { found: false };
        }

        const postUrl = new URL(match[1].replace(/&amp;/gi, "&"), searchUrl);
        if (!isTrustedGetComicsUrl(postUrl)) {
            throw new Error("GetComics search returned an unexpected post URL");
        }

        return { found: true, postUrl: postUrl.href };
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
