# 🎵 Spotify Ultimate Scraper (Tracks, Artists, Albums & Playlists)

Extract Spotify music intelligence, tracks, artist metrics (monthly listeners, verified status), album releases, playlist tracklists, follower counts, and audio durations at scale.

---

## 🌟 Key Features

- 🎧 **Comprehensive Item Support**: Scrapes Tracks, Artists, Playlists, Albums, Podcasts, and Episodes.
- 👥 **Artist Analytics**: Extracts monthly listeners, total followers, verified status, and discography links.
- 📜 **Full Playlist & Album Tracklists**: Captures complete ordered tracklists with artist names, track titles, album names, and duration in `mm:ss`.
- 🔍 **Keyword Search Extraction**: Search for any query across tracks, artists, albums, or playlists.
- ⚡ **High-Speed Dual Engine**: Fast SSR & JSON-LD extraction for single tracks, paired with dynamic headless browser for deep playlist scrolling and dynamic stats.
- 🛡️ **Apify Proxy Ready**: Seamlessly handles geoblocks, rate limits, and consent banners.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `startUrls` | Array | `["https://open.spotify.com/playlist/..."]` | List of Spotify URLs (tracks, albums, playlists, artists). |
| `searchKeywords` | Array | `[]` | Keywords to search on Spotify. |
| `searchType` | String | `"track"` | Search category: `track`, `artist`, `album`, `playlist`. |
| `maxResults` | Integer | `50` | Maximum results to extract per search query or playlist. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy configuration settings. |

---

## 📤 Output Data Format

### Playlist Record Example:
```json
{
  "id": "37i9dQZF1DXcBWIGoYBM5M",
  "type": "playlist",
  "title": "Today's Top Hits",
  "url": "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
  "description": "Jung Kook is on top of the Hottest 50!",
  "followersCount": "34,500,000 saves",
  "trackCount": 50,
  "tracks": [
    {
      "position": 1,
      "title": "Seven (feat. Latto)",
      "artists": [{ "name": "Jung Kook", "url": "https://open.spotify.com/artist/..." }],
      "album": "Seven",
      "durationFormatted": "3:04",
      "url": "https://open.spotify.com/track/..."
    }
  ],
  "coverImageUrl": "https://i.scdn.co/image/...",
  "scrapedAt": "2026-11-09T14:00:00.000Z"
}
```

### Artist Record Example:
```json
{
  "id": "66CXWjxzNUsdJxUh2aW4vG",
  "type": "artist",
  "title": "Ariana Grande",
  "url": "https://open.spotify.com/artist/66CXWjxzNUsdJxUh2aW4vG",
  "monthlyListeners": "85,420,119 monthly listeners",
  "isVerified": true,
  "coverImageUrl": "https://i.scdn.co/image/...",
  "scrapedAt": "2026-11-09T14:00:00.000Z"
}
```

---

## 💡 Practical Use Cases

1. **Music Industry Analytics**: Monitor chart performance, monthly listener growth, and playlist inclusions for record labels and A&R scouting.
2. **Curator & Influencer Discovery**: Identify influential public playlists and their curators for music promotion campaigns.
3. **Music Recommendation Systems**: Build rich music metadata databases, track relationships, and artist catalogs.
4. **Competitor & Trend Benchmarking**: Track release dates, viral tracks, and genre popularity over time.

---

## ⚖️ License
Apache-2.0
