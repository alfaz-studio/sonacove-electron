// ── State ────────────────────────────────────────────────────────────────────
let prs = [];
let token = null;
let downloading = {}; // { prNumber: progress% }

// ── DOM refs ────────────────────────────────────────────────────────────────
const listItems = document.getElementById('pr-list-items');
const listLoading = document.getElementById('pr-list-loading');
const listEmpty = document.getElementById('pr-list-empty');
const listError = document.getElementById('pr-list-error');
const errorMessage = document.getElementById('error-message');
const statusBadge = document.getElementById('status-badge');
const rateLimitEl = document.getElementById('rate-limit');
const cacheTotalEl = document.getElementById('cache-total');
const settingsPanel = document.getElementById('settings-panel');
const tokenInput = document.getElementById('github-token');
const cacheSizeEl = document.getElementById('cache-size');

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
    const settings = await window.stagingAPI.getSettings();

    token = settings.token || null;
    if (token) {
        tokenInput.value = token;
    }

    // Listen for download progress
    window.stagingAPI.onDownloadProgress(({ prNumber, progress }) => {
        downloading[prNumber] = progress;
        renderPRCard(prNumber);
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
        showLoading(prs.length === 0);
        hideError();

        const result = await window.stagingAPI.getStagingPRs(token);

        prs = result.prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        if (result.rateLimit) {
            rateLimitEl.textContent =
                `API: ${result.rateLimit.remaining}/${result.rateLimit.limit} requests remaining`;
        }

        statusBadge.textContent = `${prs.length} build${prs.length !== 1 ? 's' : ''}`;
        statusBadge.className = 'badge online';

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
    if (prs.length === 0) {
        listItems.innerHTML = '';
        listEmpty.classList.remove('hidden');

        return;
    }

    listEmpty.classList.add('hidden');
    listItems.innerHTML = prs.map(pr => buildPRCardHTML(pr)).join('');

    // Attach event listeners
    for (const pr of prs) {
        attachCardListeners(pr.prNumber);
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
    const progress = downloading[pr.prNumber] || 0;

    let statusHTML;
    let actionsHTML;

    if (!pr.hasAsset) {
        statusHTML = '<span class="status-tag no-asset">No build for this platform</span>';
        actionsHTML = '';
    } else if (isDownloading) {
        statusHTML = '<span class="status-tag not-cached">Downloading...</span>';
        actionsHTML = `
            <div class="progress-bar"><div class="progress-bar-fill" style="width: ${progress}%"></div></div>
            <span class="progress-text">${progress}%</span>`;
    } else if (pr.updateAvailable) {
        statusHTML = '<span class="status-tag update">Update Available</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="update" data-pr="${pr.prNumber}">Update & Launch</button>
            <button class="btn btn-secondary btn-action" data-action="launch" data-pr="${pr.prNumber}">Launch Cached</button>
            <button class="delete-cache-btn btn-action" data-action="delete" data-pr="${pr.prNumber}">Clear cache</button>`;
    } else if (pr.cached) {
        statusHTML = '<span class="status-tag cached">Cached</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="launch" data-pr="${pr.prNumber}">Launch</button>
            <button class="delete-cache-btn btn-action" data-action="delete" data-pr="${pr.prNumber}">Clear cache</button>`;
    } else {
        statusHTML = '<span class="status-tag not-cached">Not Downloaded</span>';
        actionsHTML = `
            <button class="btn btn-primary btn-action" data-action="download" data-pr="${pr.prNumber}">Download & Launch</button>`;
    }

    const avatarHTML = pr.authorAvatar
        ? `<img class="pr-avatar" src="${pr.authorAvatar}" alt="${pr.author}">`
        : '<div class="pr-avatar" style="background:#30363d"></div>';

    const timeAgo = formatTimeAgo(pr.updatedAt);
    const sizeStr = pr.assetSize ? formatBytes(pr.assetSize) : '';

    return `
        <div class="pr-card" id="pr-card-${pr.prNumber}">
            <div class="pr-card-header">
                ${avatarHTML}
                <div class="pr-info">
                    <div class="pr-title">#${pr.prNumber} ${escapeHtml(pr.title)}</div>
                    <div class="pr-meta">${escapeHtml(pr.author)} &middot; ${timeAgo}${sizeStr ? ` &middot; ${sizeStr}` : ''}</div>
                </div>
                <div class="pr-status">${statusHTML}</div>
            </div>
            <div class="pr-card-actions">${actionsHTML}</div>
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
        try {
            downloading[prNumber] = 0;
            renderPRCard(prNumber);

            await window.stagingAPI.downloadBuild({
                prNumber: pr.prNumber,
                assetUrl: pr.assetUrl,
                sha: pr.sha,
                token
            });

            delete downloading[prNumber];
            pr.cached = true;
            pr.updateAvailable = false;
            renderPRCard(prNumber);

            // Auto-launch after download
            await window.stagingAPI.launchBuild({ prNumber: pr.prNumber });
        } catch (err) {
            delete downloading[prNumber];
            renderPRCard(prNumber);
            alert(`Download failed: ${err.message}`);
        }
        break;

    case 'launch':
        try {
            await window.stagingAPI.launchBuild({ prNumber: pr.prNumber });
        } catch (err) {
            alert(`Launch failed: ${err.message}`);
        }
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
document.getElementById('btn-settings').addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
    if (!settingsPanel.classList.contains('hidden')) {
        refreshCacheInfo();
    }
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
    token = tokenInput.value.trim() || null;
    await window.stagingAPI.saveSettings({ token });
    settingsPanel.classList.add('hidden');
    await refreshPRs();
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

// ── Boot ────────────────────────────────────────────────────────────────────
init();
