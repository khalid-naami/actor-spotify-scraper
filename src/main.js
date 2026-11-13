import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    sanitizeRecord,
    parseSpotifyUrl,
    parseIsoDuration,
    parseLdJson,
    parseMetaTags,
    parseEmbedNextData,
    parsePathfinderJson,
    dismissCookieBanner,
    extractPlaylistTracksFromPage,
} from './extractors.js';

function isProxyTransportError(err) {
    const msg = String(err?.message || '').toUpperCase();
    return (
        msg.includes('597')
        || msg.includes('UPSTREAM407')
        || msg.includes('PROXY')
        || msg.includes('ECONNREFUSED')
        || msg.includes('407')
        || msg.includes('502')
        || msg.includes('TUNNEL')
    );
}

await Actor.init();

let browser = null;
let hasFailed = false;

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls = ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
        searchKeywords = [],
        searchType = 'track',
        maxResults = 50,
        proxyConfiguration,
    } = input;

    const safeMaxResults = Math.max(1, Math.min(500, Number(maxResults) || 50));

    log.info('Starting Spotify Ultimate Scraper...');

    // Proxy Setup with safe fallback
    let proxyConfig = null;
    let proxyUrl = undefined;
    let proxyEnabled = false;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl().catch(() => undefined);
                proxyEnabled = Boolean(proxyUrl);
                if (proxyEnabled) log.info('Apify Proxy enabled');
            }
        } catch (proxyErr) {
            log.warning(`Proxy configuration skipped (${proxyErr.message}). Falling back to direct connection.`);
        }
    }

    const getHeaders = () => ({
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    async function resilientGet(url, responseType = 'text') {
        const attempts = [];
        if (proxyEnabled && proxyUrl) attempts.push(proxyUrl);
        if (proxyEnabled && proxyConfig) {
            const rotated = await proxyConfig.newUrl().catch(() => undefined);
            if (rotated && rotated !== proxyUrl) attempts.push(rotated);
        }
        attempts.push(undefined); // Direct connection fallback

        let lastErr = null;
        for (const candidateProxy of attempts) {
            try {
                const res = await gotScraping({
                    url,
                    proxyUrl: candidateProxy,
                    headers: getHeaders(),
                    timeout: { request: 20000 },
                    responseType,
                });
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    if (!candidateProxy && proxyEnabled) {
                        log.info('Direct connection succeeded after Apify Proxy fallback.');
                        proxyEnabled = false;
                        proxyUrl = undefined;
                    } else if (candidateProxy && candidateProxy !== proxyUrl) {
                        proxyUrl = candidateProxy;
                    }
                    return res.body;
                }
                lastErr = new Error(`HTTP ${res.statusCode}`);
            } catch (err) {
                lastErr = err;
                if (candidateProxy && isProxyTransportError(err)) {
                    log.warning(`Proxy attempt failed (${err.message}); rotating / falling back to direct connection...`);
                    continue;
                }
                if (!candidateProxy) break;
            }
        }
        throw lastErr || new Error(`Failed to fetch ${url}`);
    }

    let totalItemsScraped = 0;
    let totalTracks = 0;
    let totalArtists = 0;
    let totalAlbums = 0;
    let totalPlaylists = 0;
    const diagnostics = [];

    async function pushClean(record) {
        const cleaned = sanitizeRecord({
            ...record,
            scrapedAt: record.scrapedAt || new Date().toISOString(),
        });
        await Actor.pushData(cleaned);
        totalItemsScraped++;
        return cleaned;
    }

    const launchBrowser = async (useProxy) => {
        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (useProxy && proxyEnabled && proxyUrl) {
            try {
                const u = new URL(proxyUrl);
                launchOptions.proxy = {
                    server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
                    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                };
            } catch {
                launchOptions.proxy = { server: proxyUrl };
            }
        }
        return chromium.launch(launchOptions);
    };

    const getBrowser = async () => {
        if (!browser) {
            browser = await launchBrowser(true);
        }
        return browser;
    };

    async function openSpotifyPage(url, pathfinderBag = {}) {
        const attemptGoto = async (useProxy) => {
            if (!useProxy && browser) {
                await browser.close().catch(() => {});
                browser = null;
                proxyEnabled = false;
                proxyUrl = undefined;
                browser = await launchBrowser(false);
            }
            const b = await getBrowser();
            const page = await b.newPage({ locale: 'en-US' });
            await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort().catch(() => {}));
            page.on('response', async (response) => {
                try {
                    const rUrl = response.url();
                    if (!rUrl.includes('pathfinder') && !rUrl.includes('spclient')) return;
                    if (response.status() !== 200) return;
                    const ct = response.headers()['content-type'] || '';
                    if (!ct.includes('json')) return;
                    const json = await response.json().catch(() => null);
                    if (json) parsePathfinderJson(json, pathfinderBag);
                } catch {
                    // Ignore transient interception error
                }
            });
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                return page;
            } catch (err) {
                await page.close().catch(() => {});
                throw err;
            }
        };

        try {
            return await attemptGoto(true);
        } catch (err) {
            if (proxyEnabled && isProxyTransportError(err)) {
                log.warning(`Browser proxy navigation failed (${err.message}); retrying direct...`);
                return attemptGoto(false);
            }
            throw err;
        }
    }

    // 1. Process Direct Spotify URLs
    if (Array.isArray(startUrls) && startUrls.length > 0) {
        log.info(`Processing ${startUrls.length} direct Spotify URLs...`);

        for (const rawUrl of startUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url;
            if (!targetUrl) continue;

            const parsed = parseSpotifyUrl(targetUrl);
            if (!parsed) {
                log.warning(`Unrecognized Spotify URL format: "${targetUrl}"`);
                diagnostics.push(`Unrecognized URL: ${targetUrl}`);
                continue;
            }

            log.info(`Scraping Spotify ${parsed.type.toUpperCase()}: ${parsed.cleanUrl}`);

            try {
                let html = '';
                try {
                    html = await resilientGet(parsed.cleanUrl, 'text');
                } catch (ssrErr) {
                    log.warning(`SSR fetch failed for ${parsed.cleanUrl} (${ssrErr.message}); continuing with Embed & Browser...`);
                }

                let embedData = null;
                try {
                    const embedHtml = await resilientGet(parsed.embedUrl, 'text');
                    embedData = parseEmbedNextData(embedHtml, safeMaxResults);
                } catch (embedErr) {
                    log.debug(`Embed fetch skipped for ${parsed.embedUrl}: ${embedErr.message}`);
                }

                let oembed = null;
                if (!html && !embedData?.title) {
                    try {
                        oembed = await resilientGet(`https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.cleanUrl)}`, 'json');
                    } catch {
                        // Optional fallback
                    }
                }

                const ldJson = parseLdJson(html);
                const meta = parseMetaTags(html);

                const record = {
                    id: parsed.id,
                    type: parsed.type,
                    url: parsed.cleanUrl,
                    title: embedData?.title || meta.title || oembed?.title || undefined,
                    owner: embedData?.owner || undefined,
                    description: meta.description || undefined,
                    coverImageUrl: embedData?.coverImageUrl || meta.image || oembed?.thumbnail_url || undefined,
                    audioUrl: embedData?.audioUrl || meta.audio || undefined,
                    releaseDate: embedData?.releaseDate || undefined,
                    artists: embedData?.artists || undefined,
                    durationMs: embedData?.durationMs || undefined,
                    durationFormatted: embedData?.durationFormatted || undefined,
                    trackCount: embedData?.trackCount || undefined,
                    tracks: embedData?.tracks || undefined,
                    scrapedAt: new Date().toISOString(),
                };

                if (parsed.type === 'track') {
                    if (ldJson) {
                        record.title = ldJson.name || record.title;
                        record.album = ldJson.inAlbum?.name || record.album;
                        record.releaseDate = ldJson.datePublished || record.releaseDate;
                        const durationInfo = parseIsoDuration(ldJson.duration);
                        record.durationMs = durationInfo.ms ?? record.durationMs;
                        record.durationFormatted = durationInfo.formatted ?? record.durationFormatted;

                        if (Array.isArray(ldJson.byArtist) && (!record.artists || record.artists.length === 0)) {
                            record.artists = ldJson.byArtist.map((a) => sanitizeRecord({
                                name: a.name,
                                url: a['@id'] || undefined,
                            }));
                        }
                    }
                    totalTracks++;
                } else if (parsed.type === 'playlist' || parsed.type === 'album') {
                    if (ldJson) {
                        record.title = ldJson.name || record.title;
                        if (ldJson.numTracks) record.trackCount = Number(ldJson.numTracks);
                    }

                    // Use Playwright when embed didn't return tracks, or to enrich follower count/saves & extra tracks beyond embed preview
                    const needsBrowserTracks = !Array.isArray(record.tracks) || record.tracks.length === 0 || safeMaxResults > (record.tracks?.length || 0);
                    if (needsBrowserTracks) {
                        const bag = {};
                        let page = null;
                        try {
                            page = await openSpotifyPage(parsed.cleanUrl, bag);
                            await dismissCookieBanner(page);
                            await page.waitForTimeout(2500);

                            const domTracks = await extractPlaylistTracksFromPage(page, safeMaxResults);
                            if (domTracks.length > (record.tracks?.length || 0)) {
                                record.tracks = domTracks;
                            }
                            if (!record.trackCount && Array.isArray(record.tracks) && record.tracks.length > 0) {
                                record.trackCount = record.tracks.length;
                            }

                            if (bag.title) record.title = bag.title;
                            if (bag.description && !record.description) record.description = bag.description;
                            if (bag.owner && !record.owner) record.owner = bag.owner;
                            if (bag.followersCount) record.followersCount = bag.followersCount;
                            if (bag.trackCount) record.trackCount = bag.trackCount;

                            if (!record.followersCount) {
                                const followersEl = page.locator('span:has-text("saves"), span:has-text("likes")').first();
                                if (await followersEl.isVisible({ timeout: 1000 }).catch(() => false)) {
                                    const fText = (await followersEl.innerText()).trim();
                                    if (fText) record.followersCount = fText;
                                }
                            }
                        } catch (pwErr) {
                            log.debug(`Playwright enrichment skipped for ${parsed.cleanUrl}: ${pwErr.message}`);
                        } finally {
                            if (page) await page.close().catch(() => {});
                        }
                    }

                    if (parsed.type === 'playlist') totalPlaylists++;
                    else totalAlbums++;
                } else if (parsed.type === 'artist') {
                    const bag = {};
                    let page = null;
                    try {
                        page = await openSpotifyPage(parsed.cleanUrl, bag);
                        await dismissCookieBanner(page);
                        await page.waitForTimeout(2500);

                        if (bag.monthlyListeners) record.monthlyListeners = bag.monthlyListeners;
                        if (bag.followersCount) record.followersCount = bag.followersCount;
                        if (typeof bag.isVerified === 'boolean') record.isVerified = bag.isVerified;
                        if (bag.title && !record.title) record.title = bag.title;
                        if (bag.description && !record.description) record.description = bag.description;

                        if (!record.monthlyListeners) {
                            const listenersEl = page.locator('span:has-text("monthly listeners")').first();
                            if (await listenersEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                                const text = (await listenersEl.innerText()).trim();
                                if (text) record.monthlyListeners = text;
                            }
                        }

                        if (record.isVerified === undefined) {
                            const verifiedEl = page.locator('span:has-text("Verified Artist")').first();
                            record.isVerified = await verifiedEl.isVisible({ timeout: 500 }).catch(() => false);
                        }
                    } catch (pwErr) {
                        log.debug(`Playwright artist detail extraction fallback: ${pwErr.message}`);
                    } finally {
                        if (page) await page.close().catch(() => {});
                    }
                    totalArtists++;
                }

                const cleanRec = sanitizeRecord(record);
                if (!cleanRec.title && (!cleanRec.tracks || cleanRec.tracks.length === 0)) {
                    throw new Error(`No metadata or tracks could be extracted for ${parsed.cleanUrl}`);
                }

                const saved = await pushClean(cleanRec);
                log.info(`Saved Spotify ${parsed.type.toUpperCase()}: "${saved.title || saved.id}" (${saved.tracks?.length || 0} tracks)`);
            } catch (err) {
                log.error(`Error scraping URL "${targetUrl}": ${err.message}`);
                diagnostics.push(`${targetUrl}: ${err.message}`);
            }
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching Spotify for ${searchKeywords.length} keywords (Type: ${searchType})...`);

        for (const keyword of searchKeywords) {
            if (!keyword || !String(keyword).trim()) continue;
            const cleanKeyword = String(keyword).trim();
            log.info(`Searching Spotify for: "${cleanKeyword}"`);
            let page = null;
            try {
                const searchUrl = `https://open.spotify.com/search/${encodeURIComponent(cleanKeyword)}/${searchType}s`;
                page = await openSpotifyPage(searchUrl);
                await dismissCookieBanner(page);
                await page.waitForTimeout(3000);

                const items = await page.locator(`a[href*="/${searchType}/"]`).all();
                const seenIds = new Set();
                let foundForKeyword = 0;

                for (const item of items) {
                    if (foundForKeyword >= safeMaxResults) break;

                    const href = await item.getAttribute('href').catch(() => null);
                    if (!href) continue;

                    const parsed = parseSpotifyUrl(`https://open.spotify.com${href}`);
                    if (!parsed || parsed.type !== searchType || seenIds.has(parsed.id)) continue;

                    seenIds.add(parsed.id);

                    const title = (await item.innerText().catch(() => '')).split('\n')[0].trim();
                    await pushClean({
                        id: parsed.id,
                        type: parsed.type,
                        title: title || parsed.id,
                        url: parsed.cleanUrl,
                        searchKeyword: cleanKeyword,
                    });
                    foundForKeyword++;

                    if (searchType === 'track') totalTracks++;
                    else if (searchType === 'artist') totalArtists++;
                    else if (searchType === 'album') totalAlbums++;
                    else if (searchType === 'playlist') totalPlaylists++;
                }

                log.info(`Extracted ${foundForKeyword} results for search: "${cleanKeyword}"`);
            } catch (searchErr) {
                log.error(`Error searching for "${cleanKeyword}": ${searchErr.message}`);
                diagnostics.push(`search:${cleanKeyword}: ${searchErr.message}`);
            } finally {
                if (page) await page.close().catch(() => {});
            }
        }
    }

    const summary = {
        totalItemsScraped,
        totalTracks,
        totalArtists,
        totalAlbums,
        totalPlaylists,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        status: totalItemsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`Scraping finished! Total items scraped: ${totalItemsScraped}`);

    if (totalItemsScraped === 0) {
        hasFailed = true;
        const reason = diagnostics.length > 0 ? diagnostics.join('; ') : 'No Spotify items could be extracted.';
        await Actor.fail(`Extracted 0 Spotify items. ${reason}`);
    }
} catch (err) {
    hasFailed = true;
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message }).catch(() => {});
    await Actor.fail(err.message);
} finally {
    if (browser) {
        await browser.close().catch(() => {});
    }
    if (!hasFailed) {
        await Actor.exit();
    }
}
