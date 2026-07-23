function extractFallbackTitle() {
    const urlParts = window.location.pathname.split('/');
    if (urlParts.length >= 4 && urlParts[1] === 'comic') {
        let slug = urlParts[3];
        slug = slug.replace(/-(hc|tpb|tp|gn|sc|dlx)$/i, '');
        slug = slug.replace(/-(cover|variant|cv)-?[a-z0-9-]*$/i, '');
        slug = slug.replace(/-pt-[0-9]+$/i, '');
        let query = slug.replace(/-/g, ' ');
        const abbreviations = {
            "tmnt": "teenage mutant ninja turtles",
            "asm": "amazing spider man",
            "gotg": "guardians of the galaxy",
            "jla": "justice league of america"
        };

        for (const [abbr, fullTitle] of Object.entries(abbreviations)) {
            const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
            query = query.replace(regex, fullTitle);
        }

        return query.trim();
    }
    return null;
}

function extractReleaseDate() {
    const releaseLink = Array.from(
        document.querySelectorAll('a[href*="/comics/new-comics/"]')
    ).find((link) => (
        /\/comics\/new-comics\/\d{4}\/\d{2}\/\d{2}\/?$/.test(
            link.getAttribute('href') || ''
        )
    ));

    if (!releaseLink) {
        return null;
    }

    const match = (releaseLink.getAttribute('href') || '').match(
        /\/comics\/new-comics\/(\d{4})\/(\d{2})\/(\d{2})/
    );
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function isReleaseDateInFuture(releaseDate, now = new Date()) {
    if (!releaseDate) {
        return false;
    }

    const releaseKey = Number(releaseDate.replaceAll('-', ''));
    const todayKey = (
        now.getFullYear() * 10000 +
        (now.getMonth() + 1) * 100 +
        now.getDate()
    );
    return releaseKey > todayKey;
}

function buildComicMetadata() {
    const heading = document.querySelector('h1');
    const title = (heading && heading.textContent || '').trim() || extractFallbackTitle();

    if (!title) {
        return null;
    }

    const issueMatch = title.match(/^(.*?)\s*#\s*([a-z0-9.-]+)\s*$/i);
    const releaseDate = extractReleaseDate();

    return {
        issueNumber: issueMatch ? issueMatch[2] : null,
        releaseDate,
        releaseYear: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
        seriesTitle: issueMatch ? issueMatch[1].trim() : title,
        title
    };
}

const comicMetadata = buildComicMetadata();

if (comicMetadata && !isReleaseDateInFuture(comicMetadata.releaseDate)) {
    chrome.runtime.sendMessage({
        action: "searchGetComics",
        comic: comicMetadata
    }, (response) => {
        if (response && response.found) {
            injectDownloadButtons(response.postUrl);
        }
    });
}

function injectDownloadButtons(postUrl) {
    // 1. Updated target: Find the summary row in the overview tab
    const buttonContainer = document.querySelector('#summary .listing-content');

    const btnGroup = document.createElement('div');
    // 2. Added Bootstrap classes so it fits nicely inside the layout grid
    btnGroup.className = 'col-12 mb-4'; 
    btnGroup.style.display = 'flex';
    btnGroup.style.alignItems = 'center';

    // --- The Auto-Click Function ---
    function markAsHaveIt() {
        const haveItButton = document.querySelector('.comic-controller[data-list="2"]');
        if (haveItButton) {
            haveItButton.click();
        }
    }

    // --- 1. Main Download Button ---
    const btnMain = document.createElement('button');
    btnMain.type = "button";
    btnMain.innerText = "DOWNLOAD";
    btnMain.className = "btn btn-gradient";
    btnMain.disabled = false;
    btnMain.title = "Download directly with Firefox";
    
    btnMain.style.cssText = `
        background-color: #5cb85c;
        color: #ffffff !important;
        font-weight: 800;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        margin-right: 10px; 
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: none;
        border-radius: 20px;
        padding: 8px 24px;
        cursor: pointer;
        transition: background-color 0.2s ease-in-out;
    `;
    
    btnMain.addEventListener('mouseover', () => btnMain.style.backgroundColor = '#4cae4c');
    btnMain.addEventListener('mouseout', () => btnMain.style.backgroundColor = '#5cb85c');
    btnMain.addEventListener('click', (event) => {
        event.preventDefault();

        if (btnMain.disabled) {
            return;
        }

        btnMain.disabled = true;
        btnMain.innerText = "STARTING…";
        setDownloadStatus("Starting download…", "#666666");

        chrome.runtime.sendMessage({
            action: "downloadComic",
            postUrl
        }, (response) => {
            const messageError = chrome.runtime.lastError;

            if (messageError || !response || !response.started) {
                btnMain.disabled = false;
                btnMain.innerText = "DOWNLOAD";
                setDownloadStatus(
                    "Download could not start. Use ↗ to try another GetComics mirror.",
                    "#b42318"
                );
                return;
            }

            btnMain.innerText = "PREPARING…";
            setDownloadStatus("Preparing native GetComics download…", "#666666");
        });
    });

    // --- 2. External link (🡕) Post Page Button ---
    const btnPlus = document.createElement('a');
    btnPlus.href = postUrl;
    btnPlus.innerText = "🡕";
    btnPlus.target = "_blank";
    btnPlus.rel = "noopener";
    btnPlus.className = "btn btn-gradient";
    btnPlus.title = "View all download mirrors on GetComics";
    
    btnPlus.style.cssText = `
        background-color: #5cb85c;
        color: #ffffff !important;
        font-weight: 900;
        font-size: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: none;
        border-radius: 50%;
        width: 36px;
        height: 36px;
        padding: 0;
        line-height: 1;
        transition: background-color 0.2s ease-in-out;
    `;

    btnPlus.addEventListener('mouseover', () => btnPlus.style.backgroundColor = '#4cae4c');
    btnPlus.addEventListener('mouseout', () => btnPlus.style.backgroundColor = '#5cb85c');

    btnGroup.appendChild(btnMain);
    btnGroup.appendChild(btnPlus);

    const downloadStatus = document.createElement('span');
    downloadStatus.setAttribute('role', 'status');
    downloadStatus.setAttribute('aria-live', 'polite');
    downloadStatus.style.cssText = `
        margin-left: 10px;
        font-size: 13px;
        font-weight: 600;
    `;
    btnGroup.appendChild(downloadStatus);

    function setDownloadStatus(message, color) {
        downloadStatus.textContent = message;
        downloadStatus.style.color = color;
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.postUrl !== postUrl) {
            return;
        }

        if (message.action === "comicDownloadFailed") {
            btnMain.disabled = false;
            btnMain.innerText = "DOWNLOAD";
            setDownloadStatus(
                "GetComics' file server failed. Use ↗ to try another mirror.",
                "#b42318"
            );
        } else if (message.action === "comicDownloadStarted") {
            btnMain.disabled = false;
            btnMain.innerText = "DOWNLOAD";
            markAsHaveIt();
            setDownloadStatus("Download started.", "#3c763d");
        } else if (message.action === "comicDownloadComplete") {
            setDownloadStatus("Download complete.", "#3c763d");
        }
    });

    if (buttonContainer) {
        // Insert right at the top of the summary content
        buttonContainer.insertBefore(btnGroup, buttonContainer.firstChild);
    } else {
        // Fallback
        btnGroup.style.position = 'fixed';
        btnGroup.style.bottom = '20px';
        btnGroup.style.right = '20px';
        btnGroup.style.zIndex = '9999';
        document.body.appendChild(btnGroup);
    }
}
