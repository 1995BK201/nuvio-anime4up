/**
 * Nuvio local scraper: Anime4up (Arabic-subtitled anime)
 *
 * Interface: getStreams(tmdbId, mediaType, season, episode) -> Promise<Stream[]>
 * Stream: { name, title, url, quality, headers }
 *
 * NOTE: anime4up.bond is only a gateway page. The real site rotates domains,
 * so BASE_URL is resolved at runtime (see resolveBase) with fallbacks.
 * CSS selectors are best-effort from the site's known theme; if the site changes,
 * adjust the SELECTORS block only.
 */

const TMDB_API_KEY = '4ec8d326bf945c606b8d7aa7e363d921'; // free key from themoviedb.org
const GATEWAY = 'https://www.anime4up.bond/';
const FALLBACK_BASES = ['https://4q.71wcx57.shop', 'https://w1.anime4up.rest'];

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const SELECTORS = {
  // search results: <div class="anime-card-container"> ... <div class="anime-card-title"><h3><a href>
  card: /<div class="anime-card-title">\s*<h3>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g,
  // episode list: <div class="episodes-card-title"><h3><a href>
  episode: /<div class="episodes-card-title">\s*<h3>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g,
  // server buttons on episode page
  server: /<a[^>]+data-ep-url="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  iframe: /<iframe[^>]+src="([^"]+)"/g,
};

let cachedBase = null;

async function get(url, extra) {
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' }, extra || {}),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return { text: await res.text(), url: res.url };
}

async function resolveBase() {
  if (cachedBase) return cachedBase;
  try {
    const { text } = await get(GATEWAY);
    // gateway links to the live domain (first absolute link inside the nav)
    const m = text.match(/href="(https?:\/\/[^"\/]+)\/?"[^>]*title="(?:الصفحة الرئيسية|انمي فور اب)"/);
    if (m) {
      cachedBase = m[1];
      return cachedBase;
    }
  } catch (e) {}
  for (const b of FALLBACK_BASES) {
    try {
      await get(b + '/');
      cachedBase = b;
      return b;
    } catch (e) {}
  }
  throw new Error('Anime4up: no reachable domain');
}

function all(re, s) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s))) out.push(m);
  return out;
}

function decodeServerUrl(raw) {
  let u = raw.trim();
  if (/^https?:\/\//i.test(u) || u.startsWith('//')) return u.startsWith('//') ? 'https:' + u : u;
  try {
    const d = typeof atob === 'function' ? atob(u) : Buffer.from(u, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(d)) return d;
  } catch (e) {}
  return null;
}

function qualityFrom(s) {
  const m = /(2160|1440|1080|720|480|360)/.exec(s || '');
  return m ? m[1] + 'p' : 'Unknown';
}

// Pull a playable media URL out of an embed page.
async function extractDirect(embedUrl) {
  try {
    const { text } = await get(embedUrl, { Referer: embedUrl });
    const hits = [];
    const re = /(https?:\/\/[^"'\s\\]+?\.(?:m3u8|mp4)[^"'\s\\]*)/g;
    let m;
    while ((m = re.exec(text.replace(/\\\//g, '/')))) hits.push(m[1]);
    // packed/"file:" style
    const f = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/.exec(text);
    if (f) hits.push(f[1]);
    return hits.length ? hits[0] : null;
  } catch (e) {
    return null;
  }
}

async function tmdbTitles(tmdbId, mediaType) {
  const kind = mediaType === 'movie' ? 'movie' : 'tv';
  const r = await fetch(
    'https://api.themoviedb.org/3/' + kind + '/' + tmdbId + '?api_key=' + TMDB_API_KEY
  );
  if (!r.ok) throw new Error('TMDB ' + r.status);
  const j = await r.json();
  const names = [j.name, j.original_name, j.title, j.original_title].filter(Boolean);
  return Array.from(new Set(names));
}

async function searchAnime(base, title) {
  const url = base + '/?search_param=animes&s=' + encodeURIComponent(title);
  const { text } = await get(url);
  return all(SELECTORS.card, text).map((m) => ({ url: m[1], title: m[2].trim() }));
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
}

function pickBest(results, titles) {
  const want = titles.map(norm);
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const t = norm(r.title);
    for (const w of want) {
      let score = 0;
      if (t === w) score = 3;
      else if (t.includes(w) || w.includes(t)) score = 2;
      else if (w.split(' ')[0] && t.includes(w.split(' ')[0])) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
  }
  return best;
}

async function findEpisodeUrl(animeUrl, episode) {
  const { text } = await get(animeUrl);
  const eps = all(SELECTORS.episode, text);
  const n = String(episode);
  for (const m of eps) {
    // titles look like "... الحلقة 12"
    const hit = /(?:الحلقة|episode|ep)\s*0*(\d+)/i.exec(m[2]);
    if (hit && hit[1] === n) return m[1];
  }
  return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const base = await resolveBase();
    const titles = await tmdbTitles(tmdbId, mediaType);

    let anime = null;
    for (const t of titles) {
      const results = await searchAnime(base, t);
      anime = pickBest(results, titles);
      if (anime) break;
    }
    if (!anime) return [];

    let pageUrl;
    if (mediaType === 'movie') {
      pageUrl = anime.url;
    } else {
      pageUrl = await findEpisodeUrl(anime.url, episode || 1);
      if (!pageUrl) return [];
    }

    const { text: page } = await get(pageUrl);
    const embeds = [];
    for (const m of all(SELECTORS.server, page)) {
      const u = decodeServerUrl(m[1]);
      if (u) embeds.push({ url: u, label: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    for (const m of all(SELECTORS.iframe, page)) {
      const u = decodeServerUrl(m[1]);
      if (u) embeds.push({ url: u, label: 'iframe' });
    }

    const streams = [];
    await Promise.all(
      embeds.slice(0, 8).map(async (e) => {
        const direct = await extractDirect(e.url);
        if (!direct) return;
        streams.push({
          name: 'Anime4up',
          title: e.label || 'Server',
          url: direct,
          quality: qualityFrom(e.label + ' ' + direct),
          headers: { Referer: e.url, 'User-Agent': UA },
        });
      })
    );
    return streams;
  } catch (e) {
    console.log('[Anime4up] ' + e.message);
    return [];
  }
}

module.exports = { getStreams };
