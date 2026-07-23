const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function runScript(filename, context) {
    const source = fs.readFileSync(path.join(projectRoot, filename), 'utf8');
    vm.runInNewContext(source, context, { filename });
}

function createBackgroundContext(fetchImpl) {
    const createdTabs = [];
    const removedTabs = [];
    const sentTabMessages = [];
    let downloadCreatedListener;
    let downloadChangedListener;

    const chrome = {
        runtime: {
            lastError: undefined,
            onMessage: {
                addListener() {}
            }
        },
        downloads: {
            onCreated: {
                addListener(listener) {
                    downloadCreatedListener = listener;
                }
            },
            onChanged: {
                addListener(listener) {
                    downloadChangedListener = listener;
                }
            }
        },
        tabs: {
            create(options, callback) {
                createdTabs.push(options);
                callback({ id: 321 });
            },
            remove(tabId, callback) {
                removedTabs.push(tabId);
                callback();
            },
            sendMessage(tabId, message, callback) {
                sentTabMessages.push({ tabId, message });
                callback();
            }
        }
    };

    const context = {
        URL,
        chrome,
        clearTimeout() {},
        console,
        Date,
        fetch: fetchImpl || (async () => {
            throw new Error('Unexpected fetch');
        }),
        setTimeout: () => 1
    };

    runScript('background.js', context);

    return {
        context,
        createdTabs,
        getDownloadChangedListener: () => downloadChangedListener,
        getDownloadCreatedListener: () => downloadCreatedListener,
        removedTabs,
        sentTabMessages
    };
}

test('the main League control never navigates and requests a native click', () => {
    const inserted = [];
    const sentMessages = [];
    const messageListeners = [];
    let markedAsOwned = false;

    const buttonContainer = {
        firstChild: null,
        insertBefore(element) {
            inserted.push(element);
        }
    };

    function makeElement(tagName) {
        return {
            tagName,
            children: [],
            listeners: {},
            style: {},
            addEventListener(name, listener) {
                this.listeners[name] = listener;
            },
            appendChild(child) {
                this.children.push(child);
            },
            setAttribute(name, value) {
                this[name] = value;
            }
        };
    }

    const document = {
        body: { appendChild() {} },
        createElement: makeElement,
        querySelector(selector) {
            if (selector === '#summary .listing-content') {
                return buttonContainer;
            }
            if (selector === '.comic-controller[data-list="2"]') {
                return {
                    click() {
                        markedAsOwned = true;
                    }
                };
            }
            return null;
        }
    };

    const postUrl = 'https://getcomics.org/dc/absolute-batman-1-2024/';
    const chrome = {
        runtime: {
            lastError: undefined,
            onMessage: {
                addListener(listener) {
                    messageListeners.push(listener);
                }
            },
            sendMessage(request, callback) {
                sentMessages.push(request);
                if (request.action === 'searchGetComics') {
                    callback({ found: true, postUrl });
                } else {
                    callback({ started: true, bridgeId: 'bridge-1' });
                }
            }
        }
    };

    runScript('content.js', {
        chrome,
        document,
        window: {
            location: {
                pathname: '/comic/9380901/absolute-batman-1'
            }
        }
    });

    const buttonGroup = inserted[0];
    const mainButton = buttonGroup.children[0];
    const postButton = buttonGroup.children[1];

    assert.equal(mainButton.tagName, 'button');
    assert.equal(mainButton.href, undefined);
    assert.equal(postButton.href, postUrl);

    mainButton.listeners.click({ preventDefault() {} });

    assert.deepEqual(
        JSON.parse(JSON.stringify(sentMessages[1])),
        { action: 'downloadComic', postUrl }
    );
    assert.equal(mainButton.disabled, true);
    assert.equal(mainButton.innerText, 'PREPARING…');
    assert.equal(markedAsOwned, false);

    messageListeners[0]({
        action: 'comicDownloadStarted',
        postUrl
    });

    assert.equal(mainButton.disabled, false);
    assert.equal(markedAsOwned, true);
});

test('background search returns only the matched GetComics post', async () => {
    const calls = [];
    const postUrl = 'https://getcomics.org/dc/absolute-batman-1-2024/';
    const searchHtml = `<h1 class="featured post-title"><a href="${postUrl}">Absolute Batman</a></h1>`;
    const setup = createBackgroundContext(async (url) => {
        calls.push(url);
        return {
            ok: true,
            text: async () => searchHtml
        };
    });

    const result = await setup.context.handleSearch('absolute batman 1');

    assert.equal(calls.length, 1);
    assert.deepEqual(
        JSON.parse(JSON.stringify(result)),
        { found: true, postUrl }
    );
});

test('native download runs in a non-active bridge tab that closes on download', async () => {
    const setup = createBackgroundContext();
    const postUrl = 'https://getcomics.org/dc/absolute-batman-1-2024/';
    const downloadUrl = 'https://getcomics.org/dls/protected-token';

    const startResult = await setup.context.startComicDownload(postUrl, 99);

    assert.equal(startResult.started, true);
    assert.equal(setup.createdTabs.length, 1);
    assert.equal(setup.createdTabs[0].active, false);
    assert.equal(
        setup.createdTabs[0].url.startsWith(`${postUrl}#comiceerr-download=`),
        true
    );

    const authorization = setup.context.authorizeNativeDownload(
        startResult.bridgeId,
        downloadUrl,
        321
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(authorization)),
        { allowed: true }
    );

    setup.getDownloadCreatedListener()({
        id: 42,
        referrer: postUrl,
        url: downloadUrl
    });

    assert.deepEqual(setup.removedTabs, [321]);
    assert.deepEqual(
        JSON.parse(JSON.stringify(setup.sentTabMessages[0])),
        {
            tabId: 99,
            message: {
                action: 'comicDownloadStarted',
                postUrl
            }
        }
    );

    setup.getDownloadChangedListener()({
        id: 42,
        state: { current: 'complete' }
    });

    assert.equal(
        setup.sentTabMessages[1].message.action,
        'comicDownloadComplete'
    );
});

test('the bridge clicks GetComics native DOWNLOAD NOW rather than a mirror', () => {
    const clicked = [];
    const messages = [];
    const postUrl = 'https://getcomics.org/dc/absolute-batman-1-2024/';
    const links = [
        {
            href: 'https://getcomics.org/dls/mirror',
            textContent: 'MEGA',
            getAttribute: () => 'MEGA',
            click: () => clicked.push('mirror')
        },
        {
            href: 'https://getcomics.org/dls/native',
            textContent: 'DOWNLOAD NOW',
            getAttribute: () => 'DOWNLOAD NOW',
            click: () => clicked.push('native')
        }
    ];

    const chrome = {
        runtime: {
            lastError: undefined,
            sendMessage(message, callback) {
                messages.push(message);
                callback({ allowed: true });
            }
        }
    };

    runScript('getcomics.js', {
        URL,
        chrome,
        decodeURIComponent,
        document: {
            querySelectorAll: () => links
        },
        window: {
            location: {
                hash: '#comiceerr-download=bridge-1',
                href: `${postUrl}#comiceerr-download=bridge-1`
            }
        }
    });

    assert.deepEqual(clicked, ['native']);
    assert.deepEqual(
        JSON.parse(JSON.stringify(messages[0])),
        {
            action: 'activateNativeDownload',
            bridgeId: 'bridge-1',
            downloadUrl: 'https://getcomics.org/dls/native'
        }
    );
});

test('manifest injects the bridge only on GetComics and keeps download tracking', () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
    );

    assert.equal(manifest.permissions.includes('downloads'), true);
    assert.deepEqual(
        manifest.content_scripts.map((script) => script.js),
        [['content.js'], ['getcomics.js']]
    );
    assert.equal(manifest.version, '1.3');
});
