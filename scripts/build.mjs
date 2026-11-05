// Nightly data job for the anime app. Runs on GitHub Actions (see
// .github/workflows/update-data.yml), Node 20+, no dependencies.
//
//  1. Rankings: best-rated anime overall and per genre, seasons grouped into
//     series, season count, complete/airing/new-season status, legal services.
//     -> data/top_anime.json
//  2. Arabic stories: for every anime airing this week or in the Top lists
//     that has no Arabic story yet, Claude writes one (only if
//     ANTHROPIC_API_KEY is set). Existing stories are never overwritten.
//     -> data/synopsis_ar.json
//  3. data/manifest.json: a fingerprint per file, so the app downloads only
//     what changed.
//
// AniList allows ~30-90 requests/min; this script waits 2.5 s between
// requests and backs off on 429, so a full run takes about 6-8 minutes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DATA_DIR = new URL('../data/', import.meta.url);
const GAP_MS = 2500;
const CHUNK = 15; // AniList caps query complexity at 500; 15 entries with relations fit
const PER_GENRE = 40;
const GENRES = [null, 'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance',
  'Mystery', 'Psychological', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural',
  'Thriller', 'Horror', 'Mecha', 'Music'];
const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
// Same allowlist as the app (lib/features/anime/anime_detail_repository.dart).
const LEGAL = ['crunchyroll.com', 'netflix.com', 'primevideo.com', 'amazon.com', 'amazon.co.jp',
  'amazon.de', 'disneyplus.com', 'hulu.com', 'hidive.com', 'max.com', 'hbomax.com', 'tubi.tv',
  'retrocrush.tv', 'youtube.com', 'youtu.be', 'shahid.mbc.net', 'play.yango.com', 'tod.tv',
  'osnplus.com', 'starzplay.com', 'anghami.com', 'animationdigitalnetwork.com',
  'animationdigitalnetwork.fr', 'wakanim.tv', 'joyn.de', 'rtlplus.com', 'bilibili.tv', 'iq.com',
  'iqiyi.com', 'wetv.vip', 'viu.com', 'catchplay.com', 'laftel.net', 'ani.gamer.com.tw',
  'abema.tv', 'animestore.docomo.ne.jp', 'video.unext.jp', 'tver.jp', 'v.qq.com',
  'bilibili.com', 'youku.com'];
const FIELDS = `id type format status averageScore title { romaji english }
  coverImage { large color } externalLinks { site url type }
  relations { edges { relationType(version: 2) node { id type format status } } }`;
const COVER_BASE = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------------------
// AniList

let lastRequest = 0;
async function anilist(query, variables = {}) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastRequest + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      log(`AniList ${res.status}, waiting ${retryAfter + 5}s`);
      await sleep((retryAfter + 5) * 1000);
      continue;
    }
    const json = await res.json();
    if (json.errors) throw new Error(`AniList: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
  throw new Error('AniList kept refusing requests');
}

const isLegal = (url) => {
  try {
    const host = new URL(url).host.toLowerCase();
    return LEGAL.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 1. Rankings

async function buildRankings() {
  const nodes = new Map(); // every entry is fetched once, shared across genres
  const seasonLinks = (n) => (n.relations?.edges ?? [])
    .filter((e) => (e.relationType === 'SEQUEL' || e.relationType === 'PREQUEL')
      && e.node.type === 'ANIME' && SEASON_FORMATS.has(e.node.format))
    .map((e) => [e.relationType, e.node.id]);

  async function fillSeries() {
    for (let depth = 0; depth < 12; depth++) {
      const missing = new Set();
      for (const n of nodes.values()) for (const [, id] of seasonLinks(n)) if (!nodes.has(id)) missing.add(id);
      if (!missing.size) return;
      const ids = [...missing];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const data = await anilist(`query { ${chunk.map((id) => `m${id}: Media(id: ${id}) { ${FIELDS} }`).join(' ')} }`);
        for (const v of Object.values(data)) if (v) nodes.set(v.id, v);
      }
    }
  }

  function seriesOf(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const n = nodes.get(stack.pop());
      if (!n) continue;
      for (const [, other] of seasonLinks(n)) {
        if (nodes.has(other) && !seen.has(other)) { seen.add(other); stack.push(other); }
      }
    }
    return [...seen].map((i) => nodes.get(i));
  }

  const series = {};
  const lists = {};
  for (const genre of GENRES) {
    const ids = [];
    const seen = new Set();
    for (let page = 1; page <= 4 && ids.length < PER_GENRE; page++) {
      log(`rankings: ${genre ?? 'all'} page ${page}`);
      const data = await anilist(`query ($page: Int, $genre: String) {
        Page(page: $page, perPage: 25) { pageInfo { hasNextPage }
          media(type: ANIME, sort: SCORE_DESC, isAdult: false, format_in: [TV, TV_SHORT, ONA],
                genre: $genre, popularity_greater: 15000) { ${FIELDS} } } }`, { page, genre });
      const ranked = data.Page.media;
      for (const m of ranked) nodes.set(m.id, m);
      await fillSeries();

      for (const top of ranked) {
        const members = seriesOf(top.id);
        const memberIds = new Set(members.map((m) => m.id));
        const key = Math.min(...memberIds);
        if (seen.has(key)) continue;
        seen.add(key);

        const first = members.find((m) => !seasonLinks(m).some(([t, o]) => t === 'PREQUEL' && memberIds.has(o))) ?? top;
        const statuses = new Set(members.map((m) => m.status));
        const status = statuses.has('RELEASING') || statuses.has('HIATUS') ? 'a'
          : statuses.has('NOT_YET_RELEASED') ? 'n' : 'c';
        const sites = [];
        for (const m of [first, ...members]) {
          for (const l of m.externalLinks ?? []) {
            if (l.type === 'STREAMING' && l.url && isLegal(l.url) && !sites.includes(l.site)) sites.push(l.site);
          }
        }
        const cover = first.coverImage?.large ?? top.coverImage?.large ?? null;
        series[first.id] ??= [
          first.title.english ?? first.title.romaji ?? '?',
          cover?.startsWith(COVER_BASE) ? cover.slice(COVER_BASE.length) : cover,
          (first.coverImage?.color ?? '').replace('#', ''),
          top.averageScore,
          members.filter((m) => m.status !== 'NOT_YET_RELEASED').length,
          status,
          sites.join('|'),
        ];
        ids.push(first.id);
        if (ids.length >= PER_GENRE) break;
      }
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    lists[genre ?? 'all'] = ids;
  }
  return { v: 3, coverBase: COVER_BASE, series, lists };
}

// ---------------------------------------------------------------------------
// 2. Arabic stories

const STYLE_GUIDE = `You write the Arabic story texts for an Arabic-first anime app.
For each anime you get its title and the English description from AniList.
Write one Arabic text per anime that a native Arabic reader enjoys reading.

Rules:
- Modern Standard Arabic, natural and fluent, never word-for-word. Rewrite in your own words; do not copy the English sentence structure.
- Keep it faithful: no facts, characters or events that are not in the description. Leave out production notes ("Note:", episode lists, streaming dates, "Source:").
- Length: similar to or shorter than the source; 1-5 sentences. A one-line source ("The second season of X") stays one line: "الموسم الثاني من «X»."
- Character and place names: the forms Arab anime fans use (e.g. Goku غوكو, Luffy لوفي, Conan كونان, Maomao ماوماو, Johnny Joestar جوني جوستار). Transliterate others naturally.
- Titles of works in «».
- Digits: Western (0-9).
- Mature or suggestive premises: describe neutrally and briefly, e.g. start with «كوميديا رومانسية للكبار ذات محتوى إيحائي:», no explicit details.
- No spoilers beyond what the description says.

Reply with only a JSON object mapping each id (as a string) to its Arabic text. No markdown, no comments.`;

const clean = (s) => s
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/\(\s*Source:[^)]*\)/gi, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

async function airingThisWeek() {
  const start = Math.floor(Date.now() / 1000) - 86400;
  const end = start + 9 * 86400;
  const found = new Map();
  for (let page = 1; page <= 10; page++) {
    const data = await anilist(`query ($s: Int, $e: Int, $p: Int) {
      Page(page: $p, perPage: 50) { pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $s, airingAt_lesser: $e, sort: TIME) {
          media { id isAdult title { romaji english } description } } } }`, { s: start, e: end, p: page });
    for (const a of data.Page.airingSchedules) {
      const m = a.media;
      if (m && !m.isAdult && m.description) {
        found.set(m.id, { id: m.id, title: m.title.english ?? m.title.romaji, text: clean(m.description) });
      }
    }
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return [...found.values()];
}

async function claudeTranslate(batch) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 8000,
      system: STYLE_GUIDE,
      messages: [{
        role: 'user',
        content: JSON.stringify(batch.map(({ id, title, text }) => ({ id: String(id), title, description: text }))),
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  // Keep only answers for ids we asked about, with Arabic letters in them.
  const out = {};
  for (const { id } of batch) {
    const t = parsed[String(id)];
    if (typeof t === 'string' && /[؀-ۿ]/.test(t)) out[String(id)] = t.trim();
  }
  return out;
}

/** Descriptions for specific ids (e.g. the Top lists), 40 per request. */
async function descriptionsFor(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const data = await anilist(`query { ${chunk.map((id) =>
      `m${id}: Media(id: ${id}) { id isAdult title { romaji english } description }`).join(' ')} }`);
    for (const m of Object.values(data)) {
      if (m && !m.isAdult && m.description) {
        out.push({ id: m.id, title: m.title.english ?? m.title.romaji, text: clean(m.description) });
      }
    }
  }
  return out;
}

async function updateArabicStories(current, topIds) {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('stories: no ANTHROPIC_API_KEY, skipping new translations');
    return current;
  }
  const has = (id) => Boolean(current.synopsis[String(id)]);
  // Airing this week first (people look these up now), then the Top lists.
  const airing = (await airingThisWeek()).filter((a) => !has(a.id));
  const airingIds = new Set(airing.map((a) => a.id));
  const top = await descriptionsFor(topIds.filter((id) => !has(id) && !airingIds.has(id)));
  const missing = [...airing, ...top];
  log(`stories: ${airing.length} airing + ${top.length} top anime without an Arabic story`);
  const synopsis = { ...current.synopsis };
  for (let i = 0; i < missing.length; i += 8) {
    try {
      Object.assign(synopsis, await claudeTranslate(missing.slice(i, i + 8)));
    } catch (e) {
      log(`stories: batch failed, trying again tomorrow (${e.message.slice(0, 200)})`);
    }
  }
  return { ...current, synopsis };
}

// ---------------------------------------------------------------------------
// Files

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(new URL(name, DATA_DIR), 'utf8'));
  } catch {
    return fallback;
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const manifest = await readJson('manifest.json', { files: {} });
  const outputs = {};

  let rankings = await readJson('top_anime.json', { series: {} });
  try {
    rankings = await buildRankings();
    outputs['top_anime.json'] = JSON.stringify({ ...rankings, generated: today });
  } catch (e) {
    log(`rankings failed, keeping yesterday's file: ${e.message}`);
  }

  const stories = await readJson('synopsis_ar.json', { version: 1, lang: 'ar', synopsis: {} });
  try {
    const updated = await updateArabicStories(stories, Object.keys(rankings.series).map(Number));
    outputs['synopsis_ar.json'] = JSON.stringify({ ...updated, generated: today });
  } catch (e) {
    log(`stories failed, keeping yesterday's file: ${e.message}`);
  }

  for (const [name, text] of Object.entries(outputs)) {
    const hash = sha(JSON.stringify({ ...JSON.parse(text), generated: undefined }));
    if (manifest.files[name]?.sha === hash) {
      log(`${name}: unchanged`);
      continue;
    }
    await writeFile(new URL(name, DATA_DIR), text);
    manifest.files[name] = { sha: hash, updated: today, bytes: Buffer.byteLength(text) };
    log(`${name}: updated (${Buffer.byteLength(text)} bytes)`);
  }
  manifest.checked = new Date().toISOString();
  await writeFile(new URL('manifest.json', DATA_DIR), JSON.stringify(manifest, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
