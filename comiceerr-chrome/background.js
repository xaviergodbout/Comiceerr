chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "searchGetComics") {
        handleSearch(request.query).then(sendResponse);
        return true; // Keep the message channel open for the async response
    }
});

async function handleSearch(query) {
    try {
        // 1. Search GetComics using the formatted query
        const searchUrl = `https://getcomics.org/?s=${encodeURIComponent(query)}`;
        const searchRes = await fetch(searchUrl);
        const searchText = await searchRes.text();

        // 2. Extract the first post URL from the search results
        const postLinkRegex = /<h1 class="post-title"><a href="([^"]+)"/i;
        const match = searchText.match(postLinkRegex);

        if (!match) {
            return { found: false };
        }

        const postUrl = match[1];

        // 3. Fetch the actual post page to find the download links
        const postRes = await fetch(postUrl);
        const postText = await postRes.text();

        let downloadUrl = postUrl; // Default to the post page if direct link isn't found

        // 4. Try to find the "Main Server" or standard GetComics download link
        // GetComics usually wraps their primary download in an anchor tag with specific phrasing
        const dlLinkRegex = /<a[^>]+href="([^"]+)"[^>]*title="Download Now"[^>]*>/i;
        let dlMatch = postText.match(dlLinkRegex);
        
        if (dlMatch) {
             downloadUrl = dlMatch[1];
        } else {
             // Fallback: Look for the Main Server download link specifically
             const fallbackRegex = /<a[^>]+href="([^"]+)"[^>]*>Main Server<\/a>/i;
             const fallbackMatch = postText.match(fallbackRegex);
             if (fallbackMatch) {
                 downloadUrl = fallbackMatch[1];
             }
        }

        return { found: true, downloadUrl: downloadUrl, postUrl: postUrl };

    } catch (error) {
        console.error("Error connecting to GetComics:", error);
        return { found: false };
    }
}
