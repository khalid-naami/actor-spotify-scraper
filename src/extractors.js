/**
 * Spotify Data Extraction Utilities
 */

/**
 * Identify Spotify resource type and ID from URL
 */
export function parseSpotifyUrl(url) {
    if (!url) return null;
    const match = url.match(/open\.spotify\.com\/(track|artist|album|playlist|show|episode)\/([a-zA-Z0-9]+)/);
    if (match) {
        return {
            type: match[1],
            id: match[2],
            cleanUrl: `https://open.spotify.com/${match[1]}/${match[2]}`,
        };
    }
    return null;
}

/**
 * Format milliseconds to mm:ss
 */
export function formatDuration(ms) {
    if (!ms || isNaN(ms)) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * Format ISO 8601 duration (e.g. PT3M45S) to milliseconds & formatted mm:ss
 */
export function parseIsoDuration(durationStr) {
    if (!durationStr) return { ms: null, formatted: null };
    const match = durationStr.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return { ms: null, formatted: null };
    const minutes = parseInt(match[1] || '0', 10);
    const seconds = parseInt(match[2] || '0', 10);
    const totalMs = (minutes * 60 + seconds) * 1000;
    return {
        ms: totalMs,
        formatted: `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`,
    };
}

/**
 * Extract data from Spotify Schema.org LD+JSON script
 */
export function parseLdJson(html) {
    try {
        const matches = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (!matches) return null;

        for (const script of matches) {
            const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
            const data = JSON.parse(jsonText);
            if (data && (data['@type'] || Array.isArray(data))) {
                return data;
            }
        }
    } catch {
        // Fallback
    }
    return null;
}

/**
 * Extract OpenGraph & Meta tags from HTML
 */
export function parseMetaTags(html) {
    const meta = {};
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (titleMatch) meta.title = titleMatch[1];

    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    if (descMatch) meta.description = descMatch[1];

    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (imageMatch) meta.image = imageMatch[1];

    const audioMatch = html.match(/<meta property="og:audio" content="([^"]+)"/i);
    if (audioMatch) meta.audio = audioMatch[1];

    return meta;
}

/**
 * Dismiss Spotify cookie consent banner in Playwright
 */
export async function dismissCookieBanner(page) {
    const cookieSelectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept Cookies")',
        'button:has-text("Accept all")',
        'button:has-text("I Agree")',
        'button[data-testid="cookie-banner-accept"]',
    ];

    for (const selector of cookieSelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 })) {
                await btn.click();
                await page.waitForTimeout(500);
                return true;
            }
        } catch {
            // Ignore
        }
    }
    return false;
}

/**
 * Extract tracklist rows from Spotify web player using Playwright
 */
export async function extractPlaylistTracksFromPage(page, maxResults = 100) {
    const tracks = [];
    const rows = await page.locator('div[data-testid="tracklist-row"]').all();

    for (let i = 0; i < rows.length && tracks.length < maxResults; i++) {
        const row = rows[i];
        try {
            // Track title
            const titleEl = row.locator('div[aria-colindex="2"] a, a[data-testid="internal-track-link"]').first();
            const title = (await titleEl.innerText().catch(() => '')).trim();

            const trackUrl = await titleEl.getAttribute('href').catch(() => null);
            const fullTrackUrl = trackUrl ? `https://open.spotify.com${trackUrl}` : null;

            // Artists
            const artistEls = await row.locator('div[aria-colindex="2"] span a[href*="/artist/"]').all();
            const artists = [];
            for (const a of artistEls) {
                const name = (await a.innerText().catch(() => '')).trim();
                const aHref = await a.getAttribute('href').catch(() => null);
                if (name) artists.push({ name, url: aHref ? `https://open.spotify.com${aHref}` : null });
            }

            // Album
            let album = null;
            const albumEl = row.locator('div[aria-colindex="3"] a[href*="/album/"]').first();
            if (await albumEl.isVisible({ timeout: 300 }).catch(() => false)) {
                album = (await albumEl.innerText().catch(() => '')).trim();
            }

            // Duration
            let durationFormatted = null;
            const durationEl = row.locator('div[aria-colindex="5"], div[aria-colindex="4"]').last();
            if (await durationEl.isVisible({ timeout: 300 }).catch(() => false)) {
                durationFormatted = (await durationEl.innerText().catch(() => '')).trim();
            }

            if (title) {
                tracks.push({
                    position: i + 1,
                    title,
                    artists,
                    album,
                    durationFormatted,
                    url: fullTrackUrl,
                });
            }
        } catch {
            // Skip invalid row
        }
    }

    return tracks;
}
