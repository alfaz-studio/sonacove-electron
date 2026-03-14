// ── State ────────────────────────────────────────────────────────────────────
let prs = [];
let mainBuild = null; // { buildId, title, sha, commitMessage, ... }
let token = null;
let downloading = {}; // { prNumber|buildId: progress% }
let launching = {};   // { prNumber|buildId: true }
let closedExpanded = false;
let repoBaseUrl = 'https://github.com/alfaz-studio/sonacove-electron'; // fallback

// ── DOM refs ────────────────────────────────────────────────────────────────
let prOverrides = {};  // { prNumber: { landingUrl, meetUrl } }
const listItems = document.getElementById('pr-list-items');
const listLoading = document.getElementById('pr-list-loading');
const listEmpty = document.getElementById('pr-list-empty');
const listError = document.getElementById('pr-list-error');
const errorMessage = document.getElementById('error-message');
const statusBadge = document.getElementById('status-badge');
const rateLimitEl = document.getElementById('rate-limit');
const cacheTotalEl = document.getElementById('cache-total');
const settingsOverlay = document.getElementById('settings-overlay');
const tokenInput = document.getElementById('github-token');
const cacheSizeEl = document.getElementById('cache-size');
const closedSection = document.getElementById('closed-section');
const closedListItems = document.getElementById('closed-list-items');
const closedCountEl = document.getElementById('closed-count');
const toggleClosedBtn = document.getElementById('btn-toggle-closed');
const mainBuildSection = document.getElementById('main-build-section');
const mainBuildCard = document.getElementById('main-build-card');

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
    const settings = await window.stagingAPI.getSettings();

    token = settings.token || null;
    if (token) {
        tokenInput.value = token;
    }
    prOverrides = settings.prOverrides || {};

    // Fetch repo info so URLs aren't hardcoded
    try {
        const info = await window.stagingAPI.getRepoInfo();

        repoBaseUrl = info.baseUrl;
    } catch {
        // keep fallback
    }

    // Listen for download progress
    window.stagingAPI.onDownloadProgress(({ prNumber, progress }) => {
        downloading[prNumber] = progress;
        if (prNumber === 'main') {
            renderMainBuild();
        } else {
            renderPRCard(prNumber);
        }
    });

    await refreshPRs();
    await refreshCacheInfo();

    // Auto-refresh every 2 minutes
    setInterval(refreshPRs, 120000);
}

// ── Fetch PRs ───────────────────────────────────────────────────────────────
async function refreshPRs() {
    const refreshBtn = document.getElementById('btn-refresh');

    refreshBtn.classList.add('spinning');

    try {
        showLoading(prs.length === 0 && !mainBuild);
        hideError();

        const [ result, mainResult ] = await Promise.all([
            window.stagingAPI.getStagingPRs(token),
            window.stagingAPI.getMainBuild(token)
        ]);

        prs = result.prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        mainBuild = mainResult.build;

        if (result.rateLimit) {
            rateLimitEl.textContent =
                `API: ${result.rateLimit.remaining}/${result.rateLimit.limit} requests remaining`;
        }

        const openCount = prs.filter(p => p.state === 'open').length;
        const totalCount = openCount + (mainBuild ? 1 : 0);

        statusBadge.textContent = `${totalCount} build${totalCount !== 1 ? 's' : ''}`;
        statusBadge.className = 'badge online';

        renderMainBuild();
        renderList();
    } catch (err) {
        showError(err.message);
    } finally {
        refreshBtn.classList.remove('spinning');
        hideLoading();
    }
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderList() {
    const openPRs = prs.filter(pr => pr.state === 'open');
    const closedPRs = prs.filter(pr => pr.state === 'closed');

    if (openPRs.length === 0 && closedPRs.length === 0) {
        listItems.innerHTML = '';
        closedSection.classList.add('hidden');
        listEmpty.classList.remove('hidden');

        return;
    }

    listEmpty.classList.add('hidden');

    // Render open PRs
    listItems.innerHTML = openPRs.map(pr => buildPRCardHTML(pr)).join('');

    for (const pr of openPRs) {
        attachCardListeners(pr.prNumber);
    }

    // Render closed/merged section
    if (closedPRs.length > 0) {
        closedSection.classList.remove('hidden');
        closedCountEl.textContent = `Closed / Merged (${closedPRs.length})`;
        closedListItems.innerHTML = closedPRs.map(pr => buildPRCardHTML(pr)).join('');

        for (const pr of closedPRs) {
            attachCardListeners(pr.prNumber);
        }

        // Preserve expand/collapse state
        closedListItems.classList.toggle('hidden', !closedExpanded);
        toggleClosedBtn.classList.toggle('expanded', closedExpanded);
    } else {
        closedSection.classList.add('hidden');
    }
}

// ── Main Build ──────────────────────────────────────────────────────────────
function renderMainBuild() {
    if (!mainBuild) {
        mainBuildSection.classList.add('hidden');

        return;
    }

    mainBuildSection.classList.remove('hidden');
    mainBuildCard.innerHTML = buildMainCardHTML(mainBuild);
    attachMainCardListeners();
}

function buildMainCardHTML(build) {
    const isDownloading = downloading[build.buildId] !== undefined;
    const isLaunching = launching[build.buildId];
    const progress = downloading[build.buildId] || 0;

    let accentClass = 'accent-default';
    let statusHTML;
    let actionsHTML;

    if (!build.hasAsset) {
        accentClass = 'accent-danger';
        statusHTML = '<span class="status-tag no-asset">No build for this platform</span>';
        actionsHTML = '';
    } else if (isDownloading) {
        accentClass = 'accent-active';
        statusHTML = '<span class="status-tag not-cached">Downloading...</span>';
        actionsHTML = `
            <div class="progress-bar"><div class="progress-bar-fill" style="width: ${progress}%"></div></div>
            <span class="progress-text">${progress}%</span>`;
    } else if (isLaunching) {
        accentClass = 'accent-success';
        statusHTML = '<span class="status-tag cached">Cached</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" disabled>Launching...</button>`;
    } else if (build.updateAvailable) {
        accentClass = 'accent-warning';
        statusHTML = '<span class="status-tag update">Update Available</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-main-action="update">Update & Launch</button>
            <button class="btn btn-secondary btn-action" data-main-action="launch">Launch Cached</button>
            <button class="delete-cache-btn btn-action" data-main-action="delete">Clear cache</button>`;
    } else if (build.cached) {
        accentClass = 'accent-success';
        statusHTML = '<span class="status-tag cached">Cached</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-main-action="launch">Launch</button>
            <button class="delete-cache-btn btn-action" data-main-action="delete">Clear cache</button>`;
    } else {
        statusHTML = '<span class="status-tag not-cached">Not Downloaded</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-main-action="download">Download & Launch</button>`;
    }

    const timeAgo = formatTimeAgo(build.updatedAt);
    const sizeStr = build.assetSize ? formatBytes(build.assetSize) : '';

    const commitHTML = build.commitMessage
        ? `<div class="pr-commit">
               <svg class="commit-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                   <path d="M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5h-3.32z"/>
               </svg>
               <a class="ext-link commit-link" href="#" data-url="${repoBaseUrl}/commit/${escapeHtml(build.sha)}">${escapeHtml(build.sha.substring(0, 7))}</a>
               <span class="commit-msg">${escapeHtml(build.commitMessage)}</span>
           </div>`
        : '';

    // Per-build URL override toggle + config panel
    const hasOverride = !!(prOverrides.main
        && (prOverrides.main.landingUrl || prOverrides.main.meetUrl));
    const override = prOverrides.main || {};

    if (build.hasAsset && !isDownloading && !isLaunching && actionsHTML) {
        actionsHTML += `
            <button class="url-config-toggle${hasOverride ? ' has-override' : ''}" data-main-action="toggle-urls" title="${hasOverride ? 'Custom URLs active' : 'Custom preview URLs'}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/>
                    <path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/>
                </svg>
            </button>`;
    }

    const urlConfigHTML = build.hasAsset ? `
        <div class="pr-url-config hidden" id="pr-url-config-main">
            <div class="url-field">
                <label>Landing URL</label>
                <input type="url" class="url-input" id="landing-main"
                       value="${escapeHtml(override.landingUrl || '')}"
                       placeholder="https://sonacove.catfurr.workers.dev/dashboard">
            </div>
            <div class="url-field">
                <label>Meet Root URL</label>
                <input type="url" class="url-input" id="meet-main"
                       value="${escapeHtml(override.meetUrl || '')}"
                       placeholder="https://sona-app.catfurr.workers.dev/meet">
            </div>
            <div class="url-config-actions">
                <button class="btn btn-sm btn-primary" data-main-action="save-urls">Save URLs</button>
                ${hasOverride ? '<button class="btn btn-sm btn-secondary" data-main-action="clear-urls">Reset</button>' : ''}
            </div>
        </div>` : '';

    return `
        <div class="pr-card ${accentClass}" id="main-build-inner-card">
            <div class="pr-card-header">
                <div class="pr-avatar pr-avatar-fallback main-avatar">M</div>
                <div class="pr-info">
                    <div class="pr-title-row">
                        <a class="ext-link pr-link" href="#" data-url="${repoBaseUrl}">main</a>
                        <span class="pr-title">${escapeHtml(build.title)}</span>
                    </div>
                    <div class="pr-meta">
                        <span>Latest from main</span>
                        <span class="meta-sep">&middot;</span>
                        <span>${timeAgo}</span>
                        ${sizeStr ? `<span class="meta-sep">&middot;</span><span>${sizeStr}</span>` : ''}
                    </div>
                    ${commitHTML}
                </div>
                <div class="pr-status">${statusHTML}</div>
            </div>
            <div class="pr-card-actions">${actionsHTML}</div>
            ${urlConfigHTML}
        </div>`;
}

function attachMainCardListeners() {
    const card = document.getElementById('main-build-inner-card');

    if (!card) {
        return;
    }

    for (const btn of card.querySelectorAll('[data-main-action]')) {
        btn.addEventListener('click', () => handleMainAction(btn.dataset.mainAction));
    }
}

async function handleMainAction(action) {
    if (!mainBuild) {
        return;
    }

    const buildId = 'main';

    switch (action) {
    case 'download':
    case 'update':
        downloading[buildId] = 0;
        renderMainBuild();

        try {
            await window.stagingAPI.downloadBuild({
                buildId,
                assetUrl: mainBuild.assetUrl,
                sha: mainBuild.sha,
                token
            });
        } catch (err) {
            delete downloading[buildId];
            renderMainBuild();
            alert(`Download failed: ${err.message}`);
            break;
        }

        delete downloading[buildId];
        mainBuild.cached = true;
        mainBuild.updateAvailable = false;
        renderMainBuild();
        await refreshCacheInfo();

        launching[buildId] = true;
        renderMainBuild();

        try {
            await window.stagingAPI.launchBuild({ buildId });
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            alert(`Launch failed: ${err.message}`);
        }

        delete launching[buildId];
        renderMainBuild();
        break;

    case 'launch':
        launching[buildId] = true;
        renderMainBuild();

        try {
            await window.stagingAPI.launchBuild({ buildId });
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            alert(`Launch failed: ${err.message}`);
        }

        delete launching[buildId] ;
        renderMainBuild();
        break;

    case 'delete': {
        const result = await window.stagingAPI.clearCache({ buildId });

        if (result && !result.success) {
            alert(result.error || 'Failed to clear cache.');
            break;
        }

        mainBuild.cached = false;
        mainBuild.updateAvailable = false;
        renderMainBuild();
        await refreshCacheInfo();
        break;
    }

    case 'toggle-urls': {
        const configPanel = document.getElementById('pr-url-config-main');

        if (configPanel) {
            configPanel.classList.toggle('hidden');
        }
        break;
    }

    case 'save-urls': {
        const landingInput = document.getElementById('landing-main');
        const meetInput = document.getElementById('meet-main');
        const landingUrl = landingInput ? landingInput.value.trim() : '';
        const meetUrl = meetInput ? meetInput.value.trim() : '';

        if (landingUrl || meetUrl) {
            prOverrides.main = { landingUrl: landingUrl || null, meetUrl: meetUrl || null };
        } else {
            delete prOverrides.main;
        }

        await window.stagingAPI.savePROverride({
            buildId: 'main',
            landingUrl: landingUrl || null,
            meetUrl: meetUrl || null
        });
        renderMainBuild();
        break;
    }

    case 'clear-urls':
        delete prOverrides.main;
        await window.stagingAPI.savePROverride({ buildId: 'main', landingUrl: null, meetUrl: null });
        renderMainBuild();
        break;
    }
}

function renderPRCard(prNumber) {
    const card = document.getElementById(`pr-card-${prNumber}`);

    if (!card) {
        return;
    }

    const pr = prs.find(p => p.prNumber === prNumber);

    if (!pr) {
        return;
    }

    card.outerHTML = buildPRCardHTML(pr);
    attachCardListeners(prNumber);
}

function buildPRCardHTML(pr) {
    const isDownloading = downloading[pr.prNumber] !== undefined;
    const isLaunching = launching[pr.prNumber];
    const progress = downloading[pr.prNumber] || 0;

    // Determine accent class for left border color
    let accentClass = 'accent-default';
    let statusHTML;
    let actionsHTML;

    if (!pr.hasAsset) {
        accentClass = 'accent-danger';
        statusHTML = '<span class="status-tag no-asset">No build for this platform</span>';
        actionsHTML = '';
    } else if (isDownloading) {
        accentClass = 'accent-active';
        statusHTML = '<span class="status-tag not-cached">Downloading...</span>';
        actionsHTML = `
            <div class="progress-bar"><div class="progress-bar-fill" style="width: ${progress}%"></div></div>
            <span class="progress-text">${progress}%</span>`;
    } else if (isLaunching) {
        accentClass = 'accent-success';
        statusHTML = '<span class="status-tag cached">Cached</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" disabled>Launching...</button>`;
    } else if (pr.updateAvailable) {
        accentClass = 'accent-warning';
        statusHTML = '<span class="status-tag update">Update Available</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="update" data-pr="${pr.prNumber}">Update & Launch</button>
            <button class="btn btn-secondary btn-action" data-action="launch" data-pr="${pr.prNumber}">Launch Cached</button>
            <button class="delete-cache-btn btn-action" data-action="delete" data-pr="${pr.prNumber}">Clear cache</button>`;
    } else if (pr.cached) {
        accentClass = 'accent-success';
        statusHTML = '<span class="status-tag cached">Cached</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="launch" data-pr="${pr.prNumber}">Launch</button>
            <button class="delete-cache-btn btn-action" data-action="delete" data-pr="${pr.prNumber}">Clear cache</button>`;
    } else {
        statusHTML = '<span class="status-tag not-cached">Not Downloaded</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="download" data-pr="${pr.prNumber}">Download & Launch</button>`;
    }

    const initial = (pr.author || '?')[0].toUpperCase();
    const avatarHTML = pr.authorAvatar
        ? `<img class="pr-avatar" src="${escapeHtml(pr.authorAvatar)}" alt="${escapeHtml(pr.author)}">`
        : `<div class="pr-avatar pr-avatar-fallback">${initial}</div>`;

    const timeAgo = formatTimeAgo(pr.updatedAt);
    const sizeStr = pr.assetSize ? formatBytes(pr.assetSize) : '';

    const prUrl = `${repoBaseUrl}/pull/${pr.prNumber}`;

    const commitHTML = pr.commitMessage
        ? `<div class="pr-commit">
               <svg class="commit-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                   <path d="M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5h-3.32z"/>
               </svg>
               <a class="ext-link commit-link" href="#" data-url="${repoBaseUrl}/commit/${escapeHtml(pr.sha)}">${escapeHtml(pr.sha.substring(0, 7))}</a>
               <span class="commit-msg">${escapeHtml(pr.commitMessage)}</span>
           </div>`
        : '';

    // Per-PR URL override toggle + config panel
    const hasOverride = !!(prOverrides[pr.prNumber]
        && (prOverrides[pr.prNumber].landingUrl || prOverrides[pr.prNumber].meetUrl));
    const override = prOverrides[pr.prNumber] || {};

    if (pr.hasAsset && !isDownloading && !isLaunching && actionsHTML) {
        actionsHTML += `
            <button class="url-config-toggle${hasOverride ? ' has-override' : ''}" data-action="toggle-urls" data-pr="${pr.prNumber}" title="${hasOverride ? 'Custom URLs active' : 'Custom preview URLs'}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/>
                    <path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/>
                </svg>
            </button>`;
    }

    const urlConfigHTML = pr.hasAsset ? `
        <div class="pr-url-config hidden" id="pr-url-config-${pr.prNumber}">
            <div class="url-field">
                <label>Landing URL</label>
                <input type="url" class="url-input" id="landing-${pr.prNumber}"
                       value="${escapeHtml(override.landingUrl || '')}"
                       placeholder="https://sonacove.catfurr.workers.dev/dashboard">
            </div>
            <div class="url-field">
                <label>Meet Root URL</label>
                <input type="url" class="url-input" id="meet-${pr.prNumber}"
                       value="${escapeHtml(override.meetUrl || '')}"
                       placeholder="https://sona-app.catfurr.workers.dev/meet">
            </div>
            <div class="url-config-actions">
                <button class="btn btn-sm btn-primary" data-action="save-urls" data-pr="${pr.prNumber}">Save URLs</button>
                ${hasOverride ? `<button class="btn btn-sm btn-secondary" data-action="clear-urls" data-pr="${pr.prNumber}">Reset</button>` : ''}
            </div>
        </div>` : '';

    return `
        <div class="pr-card ${accentClass}${pr.draft ? ' pr-draft' : ''}" id="pr-card-${pr.prNumber}">
            <div class="pr-card-header">
                ${avatarHTML}
                <div class="pr-info">
                    <div class="pr-title-row">
                        <a class="pr-link" href="#" data-url="${prUrl}">#${pr.prNumber}</a>
                        ${pr.draft ? '<span class="draft-badge">Draft</span>' : ''}
                        ${pr.merged ? '<span class="merged-badge">Merged</span>' : ''}
                        ${pr.state === 'closed' && !pr.merged ? '<span class="closed-badge">Closed</span>' : ''}
                        <span class="pr-title">${escapeHtml(pr.title)}</span>
                    </div>
                    <div class="pr-meta">
                        <span>${escapeHtml(pr.author)}</span>
                        <span class="meta-sep">&middot;</span>
                        <span>${timeAgo}</span>
                        ${sizeStr ? `<span class="meta-sep">&middot;</span><span>${sizeStr}</span>` : ''}
                    </div>
                    ${commitHTML}
                </div>
                <div class="pr-status">${statusHTML}</div>
            </div>
            <div class="pr-card-actions">${actionsHTML}</div>
            ${urlConfigHTML}
        </div>`;
}

function attachCardListeners(prNumber) {
    const card = document.getElementById(`pr-card-${prNumber}`);

    if (!card) {
        return;
    }

    for (const btn of card.querySelectorAll('.btn-action')) {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const pr = parseInt(btn.dataset.pr, 10);

            handleAction(action, pr);
        });
    }

    for (const link of card.querySelectorAll('.pr-link')) {
        link.addEventListener('click', e => {
            e.preventDefault();
            window.stagingAPI.openExternal(link.dataset.url);
        });
    }

    // URL config toggle
    const toggleUrlsBtn = card.querySelector('[data-action="toggle-urls"]');

    if (toggleUrlsBtn) {
        toggleUrlsBtn.addEventListener('click', () => {
            const configPanel = document.getElementById(`pr-url-config-${prNumber}`);

            if (configPanel) {
                configPanel.classList.toggle('hidden');
            }
        });
    }

    // Save per-PR URLs
    const saveUrlsBtn = card.querySelector('[data-action="save-urls"]');

    if (saveUrlsBtn) {
        saveUrlsBtn.addEventListener('click', async () => {
            const landingInput = document.getElementById(`landing-${prNumber}`);
            const meetInput = document.getElementById(`meet-${prNumber}`);
            const landingUrl = landingInput ? landingInput.value.trim() : '';
            const meetUrl = meetInput ? meetInput.value.trim() : '';

            if (landingUrl || meetUrl) {
                prOverrides[prNumber] = { landingUrl: landingUrl || null, meetUrl: meetUrl || null };
            } else {
                delete prOverrides[prNumber];
            }

            await window.stagingAPI.savePROverride({
                prNumber,
                landingUrl: landingUrl || null,
                meetUrl: meetUrl || null
            });
            renderPRCard(prNumber);
        });
    }

    // Clear per-PR URLs
    const clearUrlsBtn = card.querySelector('[data-action="clear-urls"]');

    if (clearUrlsBtn) {
        clearUrlsBtn.addEventListener('click', async () => {
            delete prOverrides[prNumber];
            await window.stagingAPI.savePROverride({ prNumber, landingUrl: null, meetUrl: null });
            renderPRCard(prNumber);
        });
    }
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function handleAction(action, prNumber) {
    const pr = prs.find(p => p.prNumber === prNumber);

    if (!pr) {
        return;
    }

    switch (action) {
    case 'download':
    case 'update':
        downloading[prNumber] = 0;
        renderPRCard(prNumber);

        try {
            await window.stagingAPI.downloadBuild({
                prNumber: pr.prNumber,
                assetUrl: pr.assetUrl,
                sha: pr.sha,
                token
            });
        } catch (err) {
            delete downloading[prNumber];
            renderPRCard(prNumber);
            alert(`Download failed: ${err.message}`);
            break;
        }

        // Download succeeded — update state and re-render
        delete downloading[prNumber];
        pr.cached = true;
        pr.cachedSha = pr.sha;
        pr.updateAvailable = false;
        renderPRCard(prNumber);
        await refreshCacheInfo();

        // Auto-launch (errors here shouldn't affect the cached state)
        launching[prNumber] = true;
        renderPRCard(prNumber);

        try {
            await window.stagingAPI.launchBuild({ prNumber: pr.prNumber });
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            alert(`Launch failed: ${err.message}`);
        }

        delete launching[prNumber];
        renderPRCard(prNumber);
        break;

    case 'launch':
        launching[prNumber] = true;
        renderPRCard(prNumber);

        try {
            await window.stagingAPI.launchBuild({ prNumber: pr.prNumber });
            // Keep "Launching..." visible long enough for the app to open
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            alert(`Launch failed: ${err.message}`);
        }

        delete launching[prNumber];
        renderPRCard(prNumber);
        break;

    case 'delete': {
        const result = await window.stagingAPI.clearCache({ prNumber: pr.prNumber });

        if (result && !result.success) {
            alert(result.error || 'Failed to clear cache.');
            break;
        }

        pr.cached = false;
        pr.updateAvailable = false;
        renderPRCard(prNumber);
        await refreshCacheInfo();
        break;
    }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────
function openSettings() {
    settingsOverlay.classList.remove('hidden');
    refreshCacheInfo();
}

function closeSettings() {
    settingsOverlay.classList.add('hidden');
}

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

// Close modal when clicking the backdrop (not the panel itself)
settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) {
        closeSettings();
    }
});

// Close modal on Escape key
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
        closeSettings();
    }
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
    token = tokenInput.value.trim() || null;

    await window.stagingAPI.saveSettings({ token });
    closeSettings();
    await refreshPRs();
});

document.getElementById('btn-check-update').addEventListener('click', async () => {
    const btn = document.getElementById('btn-check-update');

    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
        const result = await window.stagingAPI.checkForUpdates();

        if (!result.updateAvailable) {
            btn.textContent = 'Up to date';
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Check for Updates';
            }, 3000);
        }

        // If update IS available, the updater-status event handler takes over
    } catch {
        btn.textContent = 'Check failed';
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Check for Updates';
        }, 3000);
    }
});

document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    const result = await window.stagingAPI.clearCache({});

    if (result && !result.success) {
        alert(result.error || 'Failed to clear cache.');

        return;
    }

    await refreshCacheInfo();
    await refreshPRs(); // re-render to update cached status
});

// ── Closed section toggle ────────────────────────────────────────────────────
toggleClosedBtn.addEventListener('click', () => {
    closedExpanded = !closedExpanded;
    closedListItems.classList.toggle('hidden', !closedExpanded);
    toggleClosedBtn.classList.toggle('expanded', closedExpanded);
});

// ── Refresh ─────────────────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', async () => {
    await refreshPRs();
    await refreshCacheInfo();
});

document.getElementById('btn-retry').addEventListener('click', refreshPRs);

// ── Cache ───────────────────────────────────────────────────────────────────
async function refreshCacheInfo() {
    const info = await window.stagingAPI.getCacheInfo();

    cacheSizeEl.textContent = `${info.entries.length} build(s), ${formatBytes(info.totalSize)}`;
    cacheTotalEl.textContent = `Cache: ${formatBytes(info.totalSize)}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function showLoading(visible) {
    listLoading.classList.toggle('hidden', !visible);
}

function hideLoading() {
    listLoading.classList.add('hidden');
}

function showError(msg) {
    errorMessage.textContent = msg;
    listError.classList.remove('hidden');
    listItems.innerHTML = '';
    listEmpty.classList.add('hidden');
    statusBadge.textContent = 'Error';
    statusBadge.className = 'badge';
}

function hideError() {
    listError.classList.add('hidden');
}

function escapeHtml(str) {
    const div = document.createElement('div');

    div.textContent = str;

    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes === 0) {
        return '0 B';
    }
    const k = 1024;
    const sizes = [ 'B', 'KB', 'MB', 'GB' ];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMin < 1) {
        return 'just now';
    }
    if (diffMin < 60) {
        return `${diffMin}m ago`;
    }
    if (diffHr < 24) {
        return `${diffHr}h ago`;
    }

    return `${diffDays}d ago`;
}

// ── External links ──────────────────────────────────────────────────────────
document.addEventListener('click', e => {
    const link = e.target.closest('.ext-link');

    if (link) {
        e.preventDefault();
        window.stagingAPI.openExternal(link.dataset.url);
    }
});

// ── Auto-Update Status ──────────────────────────────────────────────────────
const updaterStatusItem = document.getElementById('updater-status-item');
const updaterStatusText = document.getElementById('updater-status-text');
const appVersionEl = document.getElementById('app-version');

window.stagingAPI.getAppVersion().then(version => {
    appVersionEl.textContent = `v${version}`;
});

window.stagingAPI.onUpdaterStatus(({ status, version, percent, error }) => {
    updaterStatusItem.style.display = '';

    switch (status) {
    case 'checking':
        updaterStatusText.textContent = 'Checking for updates...';
        break;
    case 'downloading':
        updaterStatusText.textContent = percent
            ? `Downloading update... ${percent}%`
            : `Update ${version} available`;
        break;
    case 'ready':
        updaterStatusText.textContent = `v${version} ready — restart to update`;
        break;
    case 'up-to-date':
        // Hide after a few seconds if up to date
        updaterStatusText.textContent = 'Up to date';
        setTimeout(() => {
            updaterStatusItem.style.display = 'none';
        }, 5000);
        break;
    case 'error':
        updaterStatusText.textContent = 'Update check failed';
        setTimeout(() => {
            updaterStatusItem.style.display = 'none';
        }, 8000);
        break;
    }
});

// ── Boot ────────────────────────────────────────────────────────────────────
init();
