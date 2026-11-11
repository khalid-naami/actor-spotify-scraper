import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    parseSpotifyUrl,
    formatDuration,
    parseIsoDuration,
    parseLdJson,
    parseMetaTags,
    dismissCookieBanner,
    extractPlaylistTracksFromPage,
} from './extractors.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls = ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
        searchKeywords = [],
        searchType = 'track',
        maxResults = 50,
        proxyConfiguration,
    } = input;

    log.info('Starting Spotify Ultimate Scraper...');

    // Proxy Setup
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        if (proxyConfig) {
            proxyUrl = await proxyConfig.newUrl();
            log.info('Apify Proxy enabled');
        }
    }

    let totalItemsScraped = 0;
    let totalTracks = 0;
    let totalArtists = 0;
    let totalAlbums = 0;
    let totalPlaylists = 0;

    // Browser instance placeholder for deep dynamic extraction
    let browser = null;

    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    // 1. Process Direct Spotify URLs
    if (Array.isArray(startUrls) && startUrls.length > 0) {
        log.info(`Processing ${startUrls.length} direct Spotify URLs...`);

        for (const rawUrl of startUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url;
            if (!targetUrl) continue;

            const parsed = parseSpotifyUrl(targetUrl);
            if (!parsed) {
                log.warning(`Unrecognized Spotify URL format: "${targetUrl}"`);
                continue;
            }

            log.info(`Scraping Spotify ${parsed.type.toUpperCase()}: ${parsed.cleanUrl}`);

            try {
                // Fetch SSR HTML with gotScraping
                const response = await gotScraping({
                    url: parsed.cleanUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 25000 },
                });

                const html = response.body;
                const ldJson = parseLdJson(html);
                const meta = parseMetaTags(html);

                let record = {
                    id: parsed.id,
                    type: parsed.type,
                    url: parsed.cleanUrl,
                    title: meta.title || null,
                    description: meta.description || null,
                    coverImageUrl: meta.image || null,
                    scrapedAt: new Date().toISOString(),
                };

                // Track extraction
                if (parsed.type === 'track') {
                    if (ldJson) {
                        record.title = ldJson.name || record.title;
                        record.album = ldJson.inAlbum?.name || null;
                        record.releaseDate = ldJson.datePublished || null;
                        const durationInfo = parseIsoDuration(ldJson.duration);
                        record.durationMs = durationInfo.ms;
                        record.durationFormatted = durationInfo.formatted;

                        if (Array.isArray(ldJson.byArtist)) {
                            record.artists = ldJson.byArtist.map((a) => ({
                                name: a.name,
                                url: a['@id'] || null,
                            }));
                        }
                    }
                    totalTracks++;
                }

                // Playlist or Album extraction
                else if (parsed.type === 'playlist' || parsed.type === 'album') {
                    if (ldJson) {
                        record.title = ldJson.name || record.title;
                        record.trackCount = ldJson.numTracks || null;
                    }

                    // Extract detailed tracklist rows using Playwright
                    try {
                        const b = await getBrowser();
                        const page = await b.newPage();
                        await page.goto(parsed.cleanUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                        await dismissCookieBanner(page);
                        await page.waitForTimeout(2000);

                        // Extract tracks
                        record.tracks = await extractPlaylistTracksFromPage(page, maxResults);
                        if (!record.trackCount && record.tracks.length > 0) {
                            record.trackCount = record.tracks.length;
                        }

                        // Extract follower count / saves if visible
                        const followersEl = page.locator('span:has-text("saves"), span:has-text("likes")').first();
                        if (await followersEl.isVisible({ timeout: 1000 }).catch(() => false)) {
                            record.followersCount = (await followersEl.innerText()).trim();
                        }

                        await page.close();
                    } catch (pwErr) {
                        log.debug(`Playwright tracklist fallback for ${parsed.cleanUrl}: ${pwErr.message}`);
                    }

                    if (parsed.type === 'playlist') totalPlaylists++;
                    else totalAlbums++;
                }

                // Artist extraction
                else if (parsed.type === 'artist') {
                    try {
                        const b = await getBrowser();
                        const page = await b.newPage();
                        await page.goto(parsed.cleanUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                        await dismissCookieBanner(page);
                        await page.waitForTimeout(2000);

                        // Monthly listeners
                        const listenersEl = page.locator('span:has-text("monthly listeners")').first();
                        if (await listenersEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                            record.monthlyListeners = (await listenersEl.innerText()).trim();
                        }

                        // Verified Artist
                        const verifiedEl = page.locator('span:has-text("Verified Artist")').first();
                        record.isVerified = await verifiedEl.isVisible({ timeout: 500 }).catch(() => false);

                        await page.close();
                    } catch (pwErr) {
                        log.debug(`Playwright artist detail extraction fallback: ${pwErr.message}`);
                    }
                    totalArtists++;
                }

                await Actor.pushData(record);
                totalItemsScraped++;
                log.info(`Saved Spotify ${parsed.type.toUpperCase()}: "${record.title}"`);

            } catch (err) {
                log.error(`Error scraping URL "${targetUrl}": ${err.message}`);
            }
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching Spotify for ${searchKeywords.length} keywords (Type: ${searchType})...`);
        const b = await getBrowser();
        const page = await b.newPage();

        for (const keyword of searchKeywords) {
            log.info(`Searching Spotify for: "${keyword}"`);
            try {
                const searchUrl = `https://open.spotify.com/search/${encodeURIComponent(keyword)}/${searchType}s`;
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                await dismissCookieBanner(page);
                await page.waitForTimeout(3000);

                // Collect results from search cards
                const items = await page.locator(`a[href*="/${searchType}/"]`).all();
                const seenIds = new Set();
                let foundForKeyword = 0;

                for (const item of items) {
                    if (foundForKeyword >= maxResults) break;

                    const href = await item.getAttribute('href').catch(() => null);
                    if (!href) continue;

                    const parsed = parseSpotifyUrl(`https://open.spotify.com${href}`);
                    if (!parsed || parsed.type !== searchType || seenIds.has(parsed.id)) continue;

                    seenIds.add(parsed.id);

                    const title = (await item.innerText().catch(() => '')).split('\n')[0].trim();
                    const record = {
                        id: parsed.id,
                        type: parsed.type,
                        title: title || null,
                        url: parsed.cleanUrl,
                        searchKeyword: keyword,
                        scrapedAt: new Date().toISOString(),
                    };

                    await Actor.pushData(record);
                    foundForKeyword++;
                    totalItemsScraped++;

                    if (searchType === 'track') totalTracks++;
                    else if (searchType === 'artist') totalArtists++;
                    else if (searchType === 'album') totalAlbums++;
                    else if (searchType === 'playlist') totalPlaylists++;
                }

                log.info(`Extracted ${foundForKeyword} results for search: "${keyword}"`);

            } catch (searchErr) {
                log.error(`Error searching for "${keyword}": ${searchErr.message}`);
            }
        }

        await page.close();
    }

    if (browser) {
        await browser.close();
    }

    // Executive Summary
    const summary = {
        totalItemsScraped,
        totalTracks,
        totalArtists,
        totalAlbums,
        totalPlaylists,
        status: 'SUCCEEDED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`Scraping finished successfully! Total items scraped: ${totalItemsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
} finally {
    await Actor.exit();
}
