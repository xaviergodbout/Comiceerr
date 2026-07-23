const BRIDGE_HASH_PREFIX = '#comiceerr-download=';

if (window.location.hash.startsWith(BRIDGE_HASH_PREFIX)) {
    const bridgeId = decodeURIComponent(
        window.location.hash.slice(BRIDGE_HASH_PREFIX.length)
    );

    const downloadLink = Array.from(document.querySelectorAll('a[href]')).find((link) => {
        const title = (link.getAttribute('title') || '').trim().toLowerCase();
        const text = (link.textContent || '').trim().toLowerCase();

        let url;
        try {
            url = new URL(link.href, window.location.href);
        } catch {
            return false;
        }

        const isProtectedDownload =
            url.protocol === 'https:' &&
            (url.hostname === 'getcomics.org' || url.hostname.endsWith('.getcomics.org')) &&
            url.pathname.startsWith('/dls/');
        const isPrimaryLink =
            title === 'download now' ||
            text.includes('download now');

        return isProtectedDownload && isPrimaryLink;
    });

    if (!downloadLink) {
        chrome.runtime.sendMessage({
            action: 'nativeDownloadUnavailable',
            bridgeId
        });
    } else {
        chrome.runtime.sendMessage({
            action: 'activateNativeDownload',
            bridgeId,
            downloadUrl: downloadLink.href
        }, (response) => {
            if (chrome.runtime.lastError || !response || !response.allowed) {
                return;
            }

            // This is the site's actual DOWNLOAD NOW element. Clicking it from
            // the loaded GetComics document preserves its full native request
            // context, cookies, redirect behavior, and download handling.
            downloadLink.click();
        });
    }
}
