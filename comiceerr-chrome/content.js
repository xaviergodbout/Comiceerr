// Extract the comic name from the URL slug
// Example: /comic/9380901/absolute-batman-1 -> "absolute batman 1"

// Extract the comic name from the URL slug and clean it up for GetComics
function extractComicTitle() {
    const urlParts = window.location.pathname.split('/');
    if (urlParts.length >= 4 && urlParts[1] === 'comic') {
        let slug = urlParts[3]; 

        // 1. Strip out common format tags at the end of the URL (-hc, -tpb, -tp, -gn, -sc, -dlx)
        slug = slug.replace(/-(hc|tpb|tp|gn|sc|dlx)$/i, '');

        // 2. Strip out cover variants (e.g., -cover-a, -variant, -blank-variant)
        slug = slug.replace(/-(cover|variant|cv)-?[a-z0-9-]*$/i, '');

        // 3. Strip out the "pt" part or issue part if formatted weirdly at the end
        slug = slug.replace(/-pt-[0-9]+$/i, '');

        // 4. Replace hyphens with spaces to format the search query
        let query = slug.replace(/-/g, ' ');

        // 5. Expand common comic abbreviations
        // Add any other abbreviations you run into down the road here!
        const abbreviations = {
            "tmnt": "teenage mutant ninja turtles",
            "asm": "amazing spider man",
            "gotg": "guardians of the galaxy",
            "jla": "justice league of america"
        };

        // Loop through the dictionary and replace abbreviations with full titles
        for (const [abbr, fullTitle] of Object.entries(abbreviations)) {
            // \\b ensures we only replace the exact word (so "tmnts" wouldn't break)
            const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
            query = query.replace(regex, fullTitle);
        }

        return query.trim();
    }
    return null;
}

const titleQuery = extractComicTitle();

if (titleQuery) {
    // Send the extracted title to the background script
    chrome.runtime.sendMessage({ action: "searchGetComics", query: titleQuery }, (response) => {
        if (response && response.found) {
            // Pass BOTH URLs to the button injection function
            injectDownloadButtons(response.downloadUrl, response.postUrl);
        }
    });
}

function injectDownloadButtons(downloadUrl, postUrl) {
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
    const btnMain = document.createElement('a');
    btnMain.href = downloadUrl;
    btnMain.innerText = "DOWNLOAD";
    btnMain.target = "_blank";
    btnMain.className = "btn btn-gradient";
    
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
        transition: background-color 0.2s ease-in-out;
    `;
    
    btnMain.addEventListener('mouseover', () => btnMain.style.backgroundColor = '#4cae4c');
    btnMain.addEventListener('mouseout', () => btnMain.style.backgroundColor = '#5cb85c');
    btnMain.addEventListener('click', markAsHaveIt);

    // --- 2. External link (🡕) Post Page Button ---
    const btnPlus = document.createElement('a');
    btnPlus.href = postUrl || downloadUrl;
    btnPlus.innerText = "🡕";
    btnPlus.target = "_blank";
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
