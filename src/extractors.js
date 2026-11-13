/**
 * Spotify Data Extraction Utilities
 */

/**
 * Recursively strips null, undefined, and NaN values so pushed records
 * conform strictly to Apify dataset schema types.
 */
export function sanitizeRecord(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => sanitizeRecord(item))
            .filter((item) => item !== null && item !== undefined);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const next = sanitizeRecord(v);
            if (next !== null && next !== undefined) {
                out[k] = next;
            }
        }
        return out;
    }
    return value;
}

/**
 * Identify Spotify resource type and ID from URL (handles intl-* locales & spotify: URIs)
 */
export function parseSpotifyUrl(url) {
    if (!url) return null;
    const raw = String(url).trim();

    const webMatch = raw.match(/open\.spotify\.com\/(?:intl-[a-z0-9-]+\/)?(track|artist|album|playlist|show|episode)\/([a-zA-Z0-9]+)/i);
    if (webMatch) {
        const type = webMatch[1].toLowerCase();
        const id = webMatch[2];
        return {
            type,
            id,
            cleanUrl: `https://open.spotify.com/${type}/${id}`,
            embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
        };
    }

    const uriMatch = raw.match(/spotify:(track|artist|album|playlist|show|episode):([a-zA-Z0-9]+)/i);
    if (uriMatch) {
        const type = uriMatch[1].toLowerCase();
        const id = uriMatch[2];
        return {
            type,
            id,
            cleanUrl: `https://open.spotify.com/${type}/${id}`,
            embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
        };
    }

    return null;
}

/**
 * Format milliseconds to mm:ss
 */
export function formatDuration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms)) || Number(ms) <= 0) return undefined;
    const totalSeconds = Math.floor(Number(ms) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * Format ISO 8601 duration (e.g. PT3M45S) to milliseconds & formatted mm:ss
 */
export function parseIsoDuration(durationStr) {
    if (!durationStr) return { ms: undefined, formatted: undefined };
    const match = String(durationStr).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
    if (!match) return { ms: undefined, formatted: undefined };
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10) + hours * 60;
    const seconds = parseInt(match[3] || '0', 10);
    const totalMs = (minutes * 60 + seconds) * 1000;
    return {
        ms: totalMs > 0 ? totalMs : undefined,
        formatted: totalMs > 0 ? `${minutes}:${seconds < 10 ? '0' : ''}${seconds}` : undefined,
    };
}

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

/**
 * Extract data from Spotify Schema.org LD+JSON script
 */
export function parseLdJson(html) {
    if (!html || typeof html !== 'string') return null;
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
    if (!html || typeof html !== 'string') return meta;

    const getMeta = (attrName, attrVal) => {
        const re1 = new RegExp(`<meta[^>]+${attrName}=["']${attrVal}["'][^>]+content=["']([^"']+)["']`, 'i');
        const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${attrVal}["']`, 'i');
        const m = html.match(re1) || html.match(re2);
        return m ? decodeHtmlEntities(m[1]).trim() : undefined;
    };

    const title = getMeta('property', 'og:title');
    if (title) meta.title = title;

    const desc = getMeta('property', 'og:description') || getMeta('name', 'description');
    if (desc) meta.description = desc;

    const image = getMeta('property', 'og:image');
    if (image) meta.image = image;

    const audio = getMeta('property', 'og:audio');
    if (audio) meta.audio = audio;

    return meta;
}

/**
 * Extract structured entity and tracklist JSON from Spotify Embed HTML (__NEXT_DATA__).
 */
export function parseEmbedNextData(html, maxResults = 100) {
    if (!html || typeof html !== 'string') return null;
    try {
        const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (!match) return null;
        const parsed = JSON.parse(match[1]);
        const entity = parsed?.props?.pageProps?.state?.data?.entity;
        if (!entity || typeof entity !== 'object') return null;

        const out = {
            title: entity.title || entity.name || undefined,
            owner: entity.subtitle || undefined,
            releaseDate: entity.releaseDate?.isoString || undefined,
            audioUrl: entity.audioPreview?.url || undefined,
        };

        const coverSources = entity.coverArt?.sources || entity.visualIdentity?.image || [];
        if (Array.isArray(coverSources) && coverSources.length > 0) {
            const best = [...coverSources].sort((a, b) => (b.maxWidth || b.width || 0) - (a.maxWidth || a.width || 0))[0];
            if (best?.url) out.coverImageUrl = best.url;
        }

        if (Array.isArray(entity.artists) && entity.artists.length > 0) {
            out.artists = entity.artists
                .map((a) => sanitizeRecord({
                    name: a.name,
                    url: a.uri ? `https://open.spotify.com/artist/${String(a.uri).split(':').pop()}` : undefined,
                }))
                .filter((a) => a.name);
        }

        if (typeof entity.duration === 'number' && entity.duration > 0) {
            out.durationMs = entity.duration;
            out.durationFormatted = formatDuration(entity.duration);
        }

        if (Array.isArray(entity.trackList) && entity.trackList.length > 0) {
            out.trackCount = entity.trackList.length;
            out.tracks = entity.trackList.slice(0, maxResults).map((t, idx) => {
                const trackUri = t.uri ? String(t.uri) : '';
                const trackId = trackUri.split(':').pop();
                const artists = t.subtitle
                    ? String(t.subtitle).split(',').map((name) => ({ name: name.trim() })).filter((a) => a.name)
                    : undefined;
                return sanitizeRecord({
                    position: idx + 1,
                    title: t.title || undefined,
                    artists,
                    durationMs: typeof t.duration === 'number' ? t.duration : undefined,
                    durationFormatted: formatDuration(t.duration),
                    url: trackId && trackUri.includes(':track:')
                        ? `https://open.spotify.com/track/${trackId}`
                        : (trackId && trackUri.includes(':episode:') ? `https://open.spotify.com/episode/${trackId}` : undefined),
                });
            }).filter((t) => t.title);
        }

        return sanitizeRecord(out);
    } catch {
        return null;
    }
}

/**
 * Passively captures Spotify Pathfinder/API JSON payloads intercepted in Playwright.
 */
export function parsePathfinderJson(payload, bag = {}) {
    if (!payload || typeof payload !== 'object') return bag;
    const data = payload.data || payload;

    const artist = data.artistUnion || data.artist;
    if (artist && typeof artist === 'object') {
        const stats = artist.stats;
        if (stats?.monthlyListeners !== undefined) {
            bag.monthlyListeners = `${Number(stats.monthlyListeners).toLocaleString('en-US')} monthly listeners`;
        }
        if (stats?.followers !== undefined) {
            bag.followersCount = Number(stats.followers).toLocaleString('en-US');
        }
        if (typeof artist.profile?.verified === 'boolean') {
            bag.isVerified = artist.profile.verified;
        }
        if (artist.profile?.name && !bag.title) {
            bag.title = artist.profile.name;
        }
        if (artist.profile?.biography?.text && !bag.description) {
            bag.description = artist.profile.biography.text;
        }
    }

    const playlist = data.playlistV2;
    if (playlist && typeof playlist === 'object') {
        if (playlist.name) bag.title = playlist.name;
        if (playlist.description) bag.description = playlist.description;
        if (playlist.followers !== undefined) {
            bag.followersCount = `${Number(playlist.followers).toLocaleString('en-US')} saves`;
        }
        if (playlist.ownerV2?.data?.name) bag.owner = playlist.ownerV2.data.name;
        if (playlist.content?.totalCount !== undefined) bag.trackCount = Number(playlist.content.totalCount);
    }

    return bag;
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
            const titleEl = row.locator('div[aria-colindex="2"] a, a[data-testid="internal-track-link"]').first();
            const title = (await titleEl.innerText().catch(() => '')).trim();

            const trackUrl = await titleEl.getAttribute('href').catch(() => null);
            const fullTrackUrl = trackUrl ? `https://open.spotify.com${trackUrl}` : undefined;

            const artistEls = await row.locator('div[aria-colindex="2"] span a[href*="/artist/"]').all();
            const artists = [];
            for (const a of artistEls) {
                const name = (await a.innerText().catch(() => '')).trim();
                const aHref = await a.getAttribute('href').catch(() => null);
                if (name) {
                    artists.push(sanitizeRecord({
                        name,
                        url: aHref ? `https://open.spotify.com${aHref}` : undefined,
                    }));
                }
            }

            let album;
            const albumEl = row.locator('div[aria-colindex="3"] a[href*="/album/"]').first();
            if (await albumEl.isVisible({ timeout: 300 }).catch(() => false)) {
                const albumText = (await albumEl.innerText().catch(() => '')).trim();
                if (albumText) album = albumText;
            }

            let durationFormatted;
            const durationEl = row.locator('div[aria-colindex="5"], div[aria-colindex="4"]').last();
            if (await durationEl.isVisible({ timeout: 300 }).catch(() => false)) {
                const durText = (await durationEl.innerText().catch(() => '')).trim();
                if (durText) durationFormatted = durText;
            }

            if (title) {
                tracks.push(sanitizeRecord({
                    position: i + 1,
                    title,
                    artists: artists.length > 0 ? artists : undefined,
                    album,
                    durationFormatted,
                    url: fullTrackUrl,
                }));
            }
        } catch {
            // Skip invalid row
        }
    }

    return tracks;
}
