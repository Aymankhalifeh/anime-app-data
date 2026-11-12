// Hourly news job for the anime app. Runs on GitHub Actions (see
// .github/workflows/update-news.yml), Node 22, no dependencies.
//
// Two kinds of news end up in data/news.json:
//
//  1. Data news, made by us from AniList: "new season announced", "official
//     trailer out", "release date set". Only facts (ids, dates); the app
//     writes the sentence in the user's language, so these are Arabic for free.
//
//  2. Feed news from official news feeds (scripts/news-sources.json). The
//     legal rule we follow: we publish only the headline, the link and the
//     source. The article text is never copied. If ANTHROPIC_API_KEY is set,
//     Claude writes a short Arabic summary in its own words from the
//     headline and the feed's teaser; the teaser itself is not published.
//
// One run per hour for everyone (the app downloads the file), so each news
// site is asked once an hour, as Anime News Network requests.
//
//   node scripts/news.mjs                    # normal run
//   node scripts/news.mjs --dry              # print, write nothing
//   NEWS_FIXTURES=./fixtures/news node scripts/news.mjs --dry   # no network

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DATA_DIR = new URL('../data/', import.meta.url);
const SCRIPT_DIR = new URL('./', import.meta.url);
const FIXTURES = process.env.NEWS_FIXTURES;
const DRY = process.argv.includes('--dry');
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.NEWS_MODEL || 'claude-haiku-5-5'; // short summaries: the small model is enough

const KEEP_DAYS = 21; // older news drops out of the file
const MAX_ITEMS = 80;
const MAX_SUMMARIES_PER_RUN = 12; // caps the cost of one run
const SEQUEL_MIN_POPULARITY = 20000; // "new season" only for shows people know
const NEW_ANIME_MIN_POPULARITY = 8000;
const GAP_MS = 2500;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// AniList

let lastRequest = 0;
async function anilist(name, query, variables = {}) {
  if (FIXTURES) return (await readJson(new URL(`anilist-${name}.json`, `file://${FIXTURES}/`), null))?.data ?? null;
  for (let attempt = 1; attempt <= 5; attempt++) {
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

const MEDIA = `id popularity format
  title { romaji english }
  coverImage { large color } bannerImage
  startDate { year month day }
  trailer { id site }`;

// The most anticipated upcoming anime: trailers and release dates.
const POPULAR_UPCOMING = `query ($page: Int) {
  Page(page: $page, perPage: 25) {
    media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA} }
  }
}`;

// The newest entries on AniList: announcements. Sequels show their prequel.
const NEWEST = `query {
  Page(perPage: 20) {
    media(type: ANIME, status: NOT_YET_RELEASED, sort: ID_DESC, isAdult: false) {
      ${MEDIA}
      relations { edges { relationType node { id type popularity } } }
    }
  }
}`;

const titleOf = (m) => m.title?.english || m.title?.romaji || '';
const dateOf = (d) =>
  d?.year && d?.month && d?.day
    ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
    : null;
const trailerOf = (t) =>
  t?.id && (t.site === 'youtube' || t.site === 'dailymotion') ? `${t.site}:${t.id}` : null;

function animeFields(m) {
  return {
    mediaId: m.id,
    title: titleOf(m),
    cover: m.coverImage?.large ?? undefined,
    color: m.coverImage?.color ?? undefined,
    banner: m.bannerImage ?? undefined,
  };
}

/** Compares AniList with what we saw last time and turns changes into news. */
async function dataNews(state, now) {
  const items = [];
  const first = !state.initialized; // first run: remember everything, announce nothing

  const popular = [];
  for (const page of [1, 2]) {
    const data = await anilist(`upcoming-${page}`, POPULAR_UPCOMING, { page });
    popular.push(...(data?.Page?.media ?? []));
  }
  const newest = (await anilist('newest', NEWEST))?.Page?.media ?? [];

  // Announcements: entries newer than anything we have seen before.
  const maxSeen = state.maxId ?? 0;
  for (const m of newest) {
    if (first || m.id <= maxSeen || !titleOf(m)) continue;
    const prequel = (m.relations?.edges ?? []).find(
      (e) => e.relationType === 'PREQUEL' && e.node?.type === 'ANIME',
    );
    const isSequel = prequel && (prequel.node.popularity ?? 0) >= SEQUEL_MIN_POPULARITY;
    if (!isSequel && (m.popularity ?? 0) < NEW_ANIME_MIN_POPULARITY) continue;
    items.push({
      id: `${isSequel ? 'season' : 'anime'}:${m.id}`,
      kind: isSequel ? 'season' : 'anime',
      time: now,
      ...animeFields(m),
      date: dateOf(m.startDate) ?? undefined,
    });
  }
  state.maxId = Math.max(maxSeen, ...newest.map((m) => m.id), ...popular.map((m) => m.id));

  // Trailers and release dates for the most anticipated shows.
  state.upcoming ??= {};
  for (const m of popular) {
    const before = state.upcoming[m.id];
    const trailer = trailerOf(m.trailer);
    const date = dateOf(m.startDate);
    if (!first && before) {
      if (trailer && trailer !== before.trailer) {
        items.push({ id: `trailer:${m.id}:${sha(trailer)}`, kind: 'trailer', time: now, ...animeFields(m), trailer });
      }
      if (date && !before.date) {
        items.push({ id: `date:${m.id}`, kind: 'date', time: now, ...animeFields(m), date });
      }
    }
    state.upcoming[m.id] = { trailer, date };
  }
  // Forget shows that are no longer upcoming, so the state file stays small.
  const still = new Set(popular.map((m) => String(m.id)));
  for (const id of Object.keys(state.upcoming)) if (!still.has(id)) delete state.upcoming[id];

  state.initialized = true;
  return items;
}

// ---------------------------------------------------------------------------
// Feeds

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const strip = (html) => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
};

/** RSS 2.0 items: headline, link, time, teaser (teaser only for the summary). */
export function parseRss(xml) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = strip(tag(body, 'title'));
    const link = tag(body, 'link');
    if (!title || !/^https:\/\//.test(link)) continue;
    const categories = [...body.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((c) =>
      strip(c[1]).toLowerCase(),
    );
    const date = new Date(tag(body, 'pubDate') || tag(body, 'dc:date'));
    items.push({
      guid: tag(body, 'guid') || link,
      title,
      link,
      time: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      teaser: strip(tag(body, 'description')).slice(0, 400),
      categories,
    });
  }
  return items;
}

async function fetchFeed(source) {
  if (FIXTURES) return readFile(new URL(`feed-${source.id}.xml`, `file://${FIXTURES}/`), 'utf8');
  const res = await fetch(source.feed, {
    headers: { 'User-Agent': 'anime-app-news/1.0 (+news once per hour)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function feedNews(sources) {
  const items = [];
  for (const source of sources) {
    try {
      const all = parseRss(await fetchFeed(source));
      const wanted = source.categories?.map((c) => c.toLowerCase());
      const filtered = all.filter(
        (i) => !wanted || i.categories.length === 0 || i.categories.some((c) => wanted.includes(c)),
      );
      // If the site renames its categories, keep everything rather than nothing.
      const kept = filtered.length ? filtered : all;
      log(`${source.id}: ${kept.length} of ${all.length} items`);
      for (const i of kept) {
        items.push({
          id: `${source.id}:${sha(i.guid)}`,
          kind: 'feed',
          time: i.time ?? new Date().toISOString(),
          source: source.id,
          headline: i.title,
          url: i.link,
          _teaser: i.teaser, // for the summary only, removed before saving
        });
      }
    } catch (e) {
      log(`${source.id}: feed skipped (${e.message})`); // keep yesterday's items
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Which anime is a headline about? (poster + link to the anime in the app)

const MAX_MATCHES_PER_RUN = 10;
const norm = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Likely anime names in a news headline, best guess first. News sites write
 * "<Name> Anime Reveals …", "<Name> Season 3 Anime's …",
 * "Crunchyroll to Stream <Name> Anime …", "… English Dub of <Name> Anime".
 */
export function titleCandidates(headline) {
  const out = [];
  const add = (s) => {
    const t = s
      .replace(/['’]s$/i, '')
      .replace(/\s+(?:Season|Part|Cour)\s+\d+$/i, '')
      .replace(/^(?:The\s+)?(?:New|Original|Live-Action)\s+/i, '')
      .trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  // "<Author>'s <Name> Manga Gets TV Anime": the name sits before "Manga".
  const source = headline.match(/^(?:.+?['’]s\s+)?(.+?)\s+(?:Manga|Light Novel|Novel|Game)\s+Gets\b/i)?.[1];
  if (source) {
    add(source);
    return out;
  }
  const before = headline.match(/^(.+?)(?:['’]s)?\s+(?:TV\s+|Film\s+|Movie\s+)?Anime\b/i)?.[1];
  if (before) {
    // Drop "Crunchyroll to Stream", "OceanVeil Streams English Dub of", "HIDIVE Adds" …
    // (greedy: the last of these words wins, so "Streams English Dub of" goes as a whole)
    const lead = before.match(
      /^.*\b(?:Streams?|to Stream|Adds|Licenses|Announces|Dub of|Simulcast of|Premieres)\s+(.+)$/i,
    )?.[1];
    if (lead) add(lead);
    add(before);
  }
  return out.slice(0, 2);
}

const SEARCH = `query ($q: String) {
  Page(perPage: 5) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
      id title { romaji english } synonyms coverImage { large color }
    }
  }
}`;

/** The AniList entry whose name really is the candidate (not a fuzzy guess). */
export function pick(candidate, media) {
  const want = norm(candidate);
  const namesOf = (m) =>
    [m.title?.english, m.title?.romaji, ...(m.synonyms ?? [])].filter(Boolean).map(norm);
  // Exact name first (the series itself), then "starts with" (e.g. "Code Geass" → "Code Geass: …").
  return (
    media.find((m) => namesOf(m).includes(want)) ??
    (want.length >= 6 ? media.find((m) => namesOf(m).some((n) => n.startsWith(want))) : undefined) ??
    null
  );
}

async function matchHeadlines(items) {
  const todo = items.filter((i) => i.kind === 'feed' && !i.matched).slice(0, MAX_MATCHES_PER_RUN);
  let found = 0;
  for (const item of todo) {
    item.matched = true; // tried; don't search again next hour
    for (const candidate of titleCandidates(item.headline)) {
      const name = `search-${norm(candidate).replace(/ /g, '-')}`;
      const media = (await anilist(name, SEARCH, { q: candidate }))?.Page?.media ?? [];
      const m = pick(candidate, media);
      if (m) {
        Object.assign(item, {
          mediaId: m.id,
          title: m.title?.english || m.title?.romaji,
          cover: m.coverImage?.large ?? undefined,
          color: m.coverImage?.color ?? undefined,
        });
        found++;
        break;
      }
    }
  }
  if (todo.length) log(`posters: ${found} of ${todo.length} headlines matched to an anime`);
}

// ---------------------------------------------------------------------------
// Arabic summaries

const NEWS_STYLE = `You write very short Arabic news summaries for an Arabic anime app.

For each item you get a headline and a teaser in English. Write 2-3 sentences of
Modern Standard Arabic, in your own words, with only the facts they contain:
what happened, which anime, when. No opinions, no hype, nothing that is not in
the input. Do not translate word for word; summarise.

Keep anime, studio and company names exactly as fans know them, in Latin letters
(e.g. "Attack on Titan", "MAPPA", "Crunchyroll"). Use Western digits (0-9).

Answer with JSON only: {"<id>": "<Arabic summary>", ...}`;

async function summarize(batch) {
  if (FIXTURES) return Object.fromEntries(batch.map((i) => [i.id, `ملخص تجريبي: ${i.headline}`]));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system: NEWS_STYLE,
      messages: [{
        role: 'user',
        content: JSON.stringify(batch.map((i) => ({ id: i.id, headline: i.headline, teaser: i._teaser }))),
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const out = {};
  for (const { id } of batch) {
    const t = parsed[id];
    if (typeof t === 'string' && /[؀-ۿ]/.test(t)) out[id] = t.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();
  const sources = await readJson(new URL('news-sources.json', SCRIPT_DIR), []);
  const previous = await readJson(new URL('news.json', DATA_DIR), { items: [] });
  const state = await readJson(new URL('news_state.json', DATA_DIR), {});

  let fresh = [];
  try {
    fresh.push(...(await dataNews(state, now)));
  } catch (e) {
    log(`AniList news skipped (${e.message})`);
  }
  fresh.push(...(await feedNews(sources)));

  // Merge: keep what we had (with its summaries), add what's new.
  const byId = new Map(previous.items.map((i) => [i.id, i]));
  for (const item of fresh) {
    const old = byId.get(item.id);
    // Keep what earlier runs added: the time first seen, the summary, the poster.
    const kept = old
      ? { time: old.time, ar: old.ar, matched: old.matched, mediaId: old.mediaId, title: old.title, cover: old.cover, color: old.color }
      : {};
    byId.set(item.id, { ...item, ...kept });
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let items = [...byId.values()]
    .filter((i) => new Date(i.time).getTime() >= cutoff)
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, MAX_ITEMS);

  // Posters: find the anime a headline is about (a few new headlines per run).
  try {
    await matchHeadlines(items);
  } catch (e) {
    log(`poster matching skipped (${e.message})`);
  }

  // Arabic summaries for feed news that has none yet (newest first).
  const todo = items.filter((i) => i.kind === 'feed' && !i.ar && i._teaser !== undefined);
  if (todo.length && (KEY || FIXTURES)) {
    const batch = todo.slice(0, MAX_SUMMARIES_PER_RUN);
    try {
      const done = await summarize(batch);
      for (const i of items) if (done[i.id]) i.ar = done[i.id];
      log(`summaries: ${Object.keys(done).length} written, ${todo.length - batch.length} left for later`);
    } catch (e) {
      log(`summaries skipped (${e.message})`);
    }
  } else if (todo.length) {
    log(`summaries: no ANTHROPIC_API_KEY, ${todo.length} items stay English for now`);
  }
  items = items.map(({ _teaser, ...rest }) => rest); // `matched` stays: it saves searches next hour

  const out = {
    v: 1,
    generated: now,
    // The app shows each source's name, and the credit line it asks for.
    sources: Object.fromEntries(sources.map((s) => [s.id, { name: s.name, credit: s.credit, home: s.home }])),
    items,
  };
  const text = JSON.stringify(out);

  if (DRY) {
    console.log(JSON.stringify(out, null, 1));
    log(`state: maxId ${state.maxId}, ${Object.keys(state.upcoming ?? {}).length} upcoming tracked`);
    return;
  }
  await writeFile(new URL('news_state.json', DATA_DIR), JSON.stringify(state));

  const manifest = await readJson(new URL('manifest.json', DATA_DIR), { files: {} });
  const hash = sha(JSON.stringify({ ...out, generated: undefined }));
  if (manifest.files['news.json']?.sha === hash) {
    log('news.json: unchanged');
    return;
  }
  await writeFile(new URL('news.json', DATA_DIR), text);
  manifest.files['news.json'] = { sha: hash, updated: now.slice(0, 10), bytes: Buffer.byteLength(text) };
  await writeFile(new URL('manifest.json', DATA_DIR), JSON.stringify(manifest, null, 1));
  log(`news.json: ${items.length} items (${Buffer.byteLength(text)} bytes)`);
}

// Run only when started as a script (node scripts/news.mjs), not when a test
// imports it to check single functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
