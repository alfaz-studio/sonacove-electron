const https = require('https');
const fs = require('original-fs');
const path = require('path');

/**
 * Core HTTPS wrapper for the GitHub REST API.
 * @param {string} apiPath  e.g. `/repos/owner/repo/releases?per_page=50`
 * @param {string} [token]  Personal access token (optional)
 * @returns {Promise<{ data: any, rateLimit: { remaining: string, limit: string } }>}
 */
function githubApi(apiPath, token) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'Sonacove-Staging-Launcher',
            Accept: 'application/vnd.github.v3+json'
        };

        if (token) {
            headers.Authorization = `token ${token}`;
        }

        const req = https.get(
            { hostname: 'api.github.com', path: apiPath, headers },
            res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            data: JSON.parse(data),
                            rateLimit: {
                                remaining: res.headers['x-ratelimit-remaining'],
                                limit: res.headers['x-ratelimit-limit']
                            }
                        });
                    } else {
                        reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('GitHub API request timed out'));
        });
    });
}

/**
 * Fetch all staging PR builds from GitHub releases.
 * @param {string} [token]  GitHub PAT
 * @param {{ owner: string, repo: string, cacheDir: string }} config
 * @returns {Promise<{ prs: object[], rateLimit: object }>}
 */
async function fetchStagingPRs(token, { owner, repo, cacheDir }) {
    // 1. Get all pre-releases matching staging-pr-*
    // NOTE: per_page=50 means only the 50 most recent results are returned
    // per endpoint.  If the project ever exceeds this, implement Link-header
    // pagination or bump the limit (max 100).
    const { data: releases, rateLimit } = await githubApi(
        `/repos/${owner}/${repo}/releases?per_page=50`,
        token
    );

    const stagingReleases = releases.filter(
        r => r.prerelease && r.tag_name.startsWith('staging-pr-')
    );

    // 2. Get all PRs for metadata (open + closed/merged)
    let prs = [];

    try {
        // Fetch open and closed PRs in parallel
        const [ openRes, closedRes ] = await Promise.all([
            githubApi(
                `/repos/${owner}/${repo}/pulls?state=open&per_page=50`,
                token
            ),
            githubApi(
                `/repos/${owner}/${repo}/pulls?state=closed&per_page=50`,
                token
            )
        ]);

        prs = [ ...openRes.data, ...closedRes.data ];
    } catch {
        // If PR fetch fails, we still have release data
    }

    const prMap = new Map(prs.map(pr => [ pr.number, pr ]));

    // 3. Fetch latest commit message for each PR's head SHA
    const shasToPrs = new Map();

    for (const release of stagingReleases) {
        const prNum = parseInt(release.tag_name.replace('staging-pr-', ''), 10);
        const pr = prMap.get(prNum);

        if (pr && pr.head && pr.head.sha) {
            shasToPrs.set(pr.head.sha, prNum);
        }
    }

    const commitMap = new Map();
    const shas = [ ...shasToPrs.keys() ];

    // Fetch commit messages — parallel when authenticated, sequential without
    // a token to avoid exhausting the 60 req/hr unauthenticated rate limit.
    if (token) {
        await Promise.all(shas.map(async sha => {
            try {
                const { data } = await githubApi(
                    `/repos/${owner}/${repo}/commits/${sha}`,
                    token
                );

                commitMap.set(sha, data.commit.message.split('\n')[0]);
            } catch {
                // Ignore — commit message is optional
            }
        }));
    } else {
        for (const sha of shas) {
            try {
                const { data } = await githubApi(
                    `/repos/${owner}/${repo}/commits/${sha}`,
                    token
                );

                commitMap.set(sha, data.commit.message.split('\n')[0]);
            } catch (err) {
                // Stop fetching on rate limit; skip individual failures
                if (err.message.includes('403') || err.message.includes('429')) {
                    break;
                }
            }
        }
    }

    // 4. Merge release + PR + commit data
    const results = stagingReleases.map(release => {
        const prNum = parseInt(release.tag_name.replace('staging-pr-', ''), 10);
        const pr = prMap.get(prNum);
        const headSha = pr && pr.head ? pr.head.sha : null;

        // Determine which assets are available for this platform
        const platform = process.platform === 'darwin' ? 'mac' : 'win';
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        let assetName;

        if (platform === 'mac') {
            assetName = `sonacove-staging-mac-${arch}.zip`;
        } else {
            assetName = 'sonacove-staging-win-x64.zip';
        }

        const asset = release.assets.find(a => a.name === assetName);

        // Check cache status
        const prCacheDir = path.join(cacheDir, `pr-${prNum}`);
        const metaPath = path.join(prCacheDir, 'meta.json');
        let cached = false;
        let cachedSha = null;

        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

                cached = true;
                cachedSha = meta.sha;
            } catch {
                // Corrupt meta, treat as not cached
            }
        }

        const prState = pr ? pr.state : 'open'; // assume open if no PR metadata
        const merged = pr ? !!pr.merged_at : false;

        return {
            prNumber: prNum,
            title: pr ? pr.title : `PR #${prNum}`,
            author: pr ? pr.user.login : 'unknown',
            authorAvatar: pr ? pr.user.avatar_url : null,
            draft: pr ? !!pr.draft : false,
            state: prState,
            merged,
            sha: headSha || release.target_commitish,
            commitMessage: headSha ? (commitMap.get(headSha) || null) : null,
            updatedAt: release.published_at || release.created_at,
            assetName,
            assetUrl: asset ? asset.url : null,
            assetSize: asset ? asset.size : 0,
            hasAsset: !!asset,
            cached,
            updateAvailable: cached && cachedSha !== (headSha || release.target_commitish)
        };
    });

    return { prs: results, rateLimit };
}

module.exports = { githubApi, fetchStagingPRs };
