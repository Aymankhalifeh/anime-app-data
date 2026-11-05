// Weekly price job for the anime app. Runs on GitHub Actions (see
// .github/workflows/update-prices.yml), Node 22, no dependencies.
//
// It reads scripts/price-sources.json, fetches each service's pricing page
// *from inside each country* (prices are geo-dependent), pulls the plan prices
// out of the page, checks them, and writes data/prices.json sorted cheapest
// first per country.
//
// The golden rule: a wrong price is worse than an old price. Anything that
// fails a check keeps last week's value and is listed under "needs_check"
// instead of going into the app.
//
//   node scripts/prices.mjs                 # normal run
//   node scripts/prices.mjs --dry           # show what would change, write nothing
//   node scripts/prices.mjs --only=netflix  # one service
//   FIXTURES=./fixtures node scripts/prices.mjs --dry   # read saved pages, no network
//
// Country-targeted fetching needs FIRECRAWL_API_KEY (free tier is plenty:
// ~1 credit per page, a few hundred pages a month). Without it the job still
// runs, but every page comes from the GitHub runner's own country, so the
// currency check rejects nearly everything and old prices are kept.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DATA_DIR = new URL('../data/', import.meta.url);
const SCRIPT_DIR = new URL('./', import.meta.url);
const KEY = process.env.FIRECRAWL_API_KEY;
const FIXTURES = process.env.FIXTURES;
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const ONLY = ARGS.find((a) => a.startsWith('--only='))?.slice(7);
const TODAY = new Date().toISOString().slice(0, 10);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Money

// Only the country's own currency is ever accepted. That one rule throws out
// most of what goes wrong: promo pages in EUR, US prices, half-loaded pages.
const CURRENCY_TOKENS = {
  EUR: ['€', 'EUR'],
  SAR: ['SAR', 'SR', '﷼', 'ر.س'],
  AED: ['AED', 'د.إ'],
  EGP: ['EGP', 'LE', 'E£', 'ج.م'],
  USD: ['USD', 'US$', '$'],
  GBP: ['GBP', '£'],
};

const MONTH_WORDS = ['month', 'monat', 'mo.', '/mo', 'mth', 'شهر'];
const YEAR_WORDS = ['year', 'jahr', 'annual', 'jahres', '/yr', 'سنة', 'سنوي'];
// Discounts and intro offers look like real prices but are not what you pay.
const PROMO_WORDS = ['spar', 'promo', 'offer', 'angebot', 'rabatt', 'discount', 'statt',
  'instead', 'trial', 'testen', 'first', 'for 6', 'für 6', 'limited', 'عرض', 'خصم', 'تجربة'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "1.234,56" / "1,234.56" / "6,99" / "35" -> number */
function parseAmount(raw) {
  let s = raw.replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const sep = Math.max(lastComma, lastDot);
  if (sep >= 0 && /^\d{1,2}$/.test(s.slice(sep + 1))) {
    s = s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1);
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Every amount written in `currency`, with where it sits and what it is called. */
function findAmounts(text, currency) {
  const tokens = CURRENCY_TOKENS[currency] ?? [currency];
  const alt = tokens.map(escapeRe).join('|');
  const num = '\\d{1,3}(?:[.,\\s]\\d{3})*(?:[.,]\\d{1,2})?';
  const re = new RegExp(`(?:(${alt})\\s*(${num}))|(?:(${num})\\s*(${alt}))`, 'gi');
  const out = [];
  for (const m of text.matchAll(re)) {
    const value = parseAmount(m[2] ?? m[3]);
    if (value === null || value <= 0) continue;
    // Narrow window, and never across a line break: "15,99 € / Monat" and
    // "11,99 € im Sparpreis" sit close together on these pages, and a "/ Jahr"
    // on the line above would otherwise turn a monthly price into a yearly one.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index) === -1 ? text.length : text.indexOf('\n', m.index);
    const end = m.index + m[0].length;
    const around = text
      .slice(Math.max(lineStart, m.index - 20), Math.min(lineEnd, end + 35))
      .toLowerCase();
    // What comes straight after the amount wins: in "$21.49/month or $214.99/year"
    // the first price is monthly, even though the word "year" is close by.
    const after = text.slice(end, Math.min(lineEnd, end + 18)).toLowerCase();
    const has = (hay, words) => words.some((w) => hay.includes(w));
    out.push({
      value,
      index: m.index,
      lineStart,
      period: has(after, MONTH_WORDS) ? 'month'
        : has(after, YEAR_WORDS) ? 'year'
        : has(around, MONTH_WORDS) ? 'month'
        : has(around, YEAR_WORDS) ? 'year' : null,
      promo: PROMO_WORDS.some((w) => around.includes(w)),
      line: lineAt(text, m.index),
    });
  }
  return out;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/** "- Basic: 35 SAR/month" -> plan name */
function labelFromLine(line) {
  const label = line
    .replace(/^[-*\s>|]+/, '')          // bullet first, or the split eats the line
    .split(/\s[-–]\s|:/)[0]
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  return label.length >= 2 && label.length <= 40 && /[A-Za-z؀-ۿ]/.test(label)
    ? label : null;
}

// ---------------------------------------------------------------------------
// Fetching (country-targeted)

async function fetchPage(url, country, lang, serviceId) {
  if (FIXTURES) {
    const text = await readFile(new URL(`${serviceId}-${country}.md`, `file://${FIXTURES}/`), 'utf8');
    return { text, geo: true, from: 'fixture' };
  }
  if (!KEY) {
    // No key: whatever country the runner happens to be in. Kept honest by
    // the currency check downstream.
    const res = await fetch(url, { headers: { 'User-Agent': 'anime-app-price-check/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { text: stripHtml(html), geo: false, from: 'direct' };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        location: { country, languages: [lang] },
        timeout: 60000,
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(attempt * 15000);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    const text = json.data?.markdown;
    if (!text) throw new Error('no markdown in response');
    return { text, geo: true, from: 'firecrawl' };
  }
  throw new Error('firecrawl kept failing');
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Reading plans out of a page

function extractPlans(text, service, country, countryInfo) {
  const cfg = service.scrape;
  const currency = countryInfo.currency;

  // Some pages say which country they are showing. If ours says so and names
  // the wrong one, the geo-targeting didn't work and nothing here is usable.
  if (cfg.expectCountryName && !text.toLowerCase().includes(countryInfo.name.toLowerCase())) {
    return { error: `page does not mention ${countryInfo.name} - wrong country served` };
  }

  let amounts = findAmounts(text, currency);
  if (!amounts.length) return { error: `no price in ${currency} on the page` };
  if (cfg.monthlyOnly !== false) amounts = amounts.filter((a) => a.period !== 'year');
  amounts = amounts.filter((a) => !a.promo);
  if (!amounts.length) return { error: `only yearly or promo prices in ${currency}` };

  const max = cfg.maxPlans ?? 4;
  let plans;
  if (cfg.strategy === 'labelled') {
    const seen = new Set();
    plans = [];
    for (const a of amounts) {
      const name = labelFromLine(a.line);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      plans.push({ plan: name, price: a.value, period: a.period ?? 'month' });
    }
    if (!plans.length) return { error: 'found prices but no plan names next to them' };
  } else {
    // One price per line: pages write the regular price first and the
    // discount after it ("15,99 € / Monat oder 11,99 € im Sparpreis").
    const firstPerLine = [...new Map(
      [...amounts].reverse().map((a) => [a.lineStart, a]),
    ).values()];
    // Cheapest distinct amounts, matched to the plan names from the config.
    const uniq = [...new Map(firstPerLine.map((a) => [a.value, a])).values()]
      .sort((x, y) => x.value - y.value)
      .slice(0, max);
    // Some services sell different plan line-ups per country (Disney+ has one
    // plan in the Gulf, three in the US).
    const names = cfg.plansByCountry?.[country] ?? cfg.plans ?? [];
    plans = uniq.map((a, i) => ({
      plan: names[i] ?? `Plan ${i + 1}`,
      price: a.value,
      period: a.period ?? 'month',
    }));
  }
  return { plans: plans.slice(0, max) };
}

// ---------------------------------------------------------------------------
// Checks

const perMonth = (p) => Math.round((p.period === 'year' ? p.price / 12 : p.price) * 100) / 100;

/** Compares against last week so a redesigned page can't quietly halve a price. */
function sanityCheck(plans, previous) {
  for (const p of plans) {
    if (!(p.price > 0) || p.price > 100000) return `price out of range: ${p.price}`;
  }
  if (!previous?.length) return null;
  const oldCheapest = Math.min(...previous.map(perMonth));
  const newCheapest = Math.min(...plans.map(perMonth));
  const change = Math.abs(newCheapest - oldCheapest) / oldCheapest;
  if (change > 0.5) {
    return `cheapest plan jumped from ${oldCheapest} to ${newCheapest} (${Math.round(change * 100)}%)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Files

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const sources = await readJson(new URL('price-sources.json', SCRIPT_DIR), null);
  if (!sources) throw new Error('scripts/price-sources.json is missing');
  const manual = await readJson(new URL('price-manual.json', SCRIPT_DIR), { countries: {} });
  const prev = await readJson(new URL('prices.json', DATA_DIR), { countries: {} });

  const out = { version: 1, generated: TODAY, countries: {}, needs_check: [] };
  const services = sources.services.filter((s) => !ONLY || s.id === ONLY);

  for (const [code, info] of Object.entries(sources.countries)) {
    const entries = [];
    for (const service of services) {
      if (!service.countries.includes(code)) continue;

      const manualEntry = manual.countries?.[code]?.[service.id];
      const previous = (prev.countries?.[code]?.services ?? [])
        .filter((e) => e.id === service.id);

      // A hand-written entry marked "lock" is never touched by the scraper.
      if (manualEntry?.lock || service.manualOnly) {
        if (manualEntry?.plans?.length) {
          entries.push(...toEntries(service, manualEntry.plans, 'manual',
            manualEntry.checked ?? TODAY, manualEntry.currency));
        } else if (previous.length) {
          entries.push(...previous);
        } else {
          out.needs_check.push(`${code} ${service.id}: no price yet - add it to price-manual.json`);
        }
        continue;
      }

      let result;
      try {
        const url = service.scrape.localeUrl?.[code] ?? service.scrape.url;
        const page = await fetchPage(url, code, service.scrape.lang ?? info.lang, service.id);
        result = extractPlans(page.text, service, code, info);
        if (!result.error && !page.geo) result = { error: 'no country-targeted fetch (no API key)' };
        if (!result.error) {
          const problem = sanityCheck(result.plans, previous);
          if (problem) result = { error: problem };
        }
      } catch (e) {
        result = { error: e.message.slice(0, 120) };
      }

      if (result.error) {
        // Keep what we had; never ship a guess.
        if (previous.length) {
          entries.push(...previous.map((e) => ({ ...e, stale: true })));
        } else if (manualEntry?.plans?.length) {
          entries.push(...toEntries(service, manualEntry.plans, 'manual',
            manualEntry.checked ?? TODAY, manualEntry.currency));
        }
        out.needs_check.push(`${code} ${service.id}: ${result.error}`);
        log(`  ${code} ${service.id}: ${result.error}`);
      } else {
        entries.push(...toEntries(service, result.plans, 'auto', TODAY));
        log(`  ${code} ${service.id}: ${result.plans.map((p) => `${p.plan} ${p.price}`).join(', ')}`);
      }
      if (!FIXTURES) await sleep(2000);
    }

    // Prices in the country's own currency are comparable, so they sort first;
    // anything billed in another currency follows (no made-up conversion).
    entries.sort((a, b) =>
      (a.currency ? 1 : 0) - (b.currency ? 1 : 0) || a.perMonth - b.perMonth);
    out.countries[code] = { currency: info.currency, name: info.name, nameAr: info.nameAr, services: entries };
  }

  const text = JSON.stringify(out);
  log(`${out.needs_check.length} entries need a look`);
  if (DRY) {
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  const manifest = await readJson(new URL('manifest.json', DATA_DIR), { files: {} });
  const hash = sha(JSON.stringify({ ...out, generated: undefined, needs_check: undefined }));
  if (manifest.files['prices.json']?.sha === hash) {
    log('prices.json: unchanged');
  } else {
    await writeFile(new URL('prices.json', DATA_DIR), text);
    manifest.files['prices.json'] = { sha: hash, updated: TODAY, bytes: Buffer.byteLength(text) };
    await writeFile(new URL('manifest.json', DATA_DIR), JSON.stringify(manifest, null, 1));
    log(`prices.json: updated (${Buffer.byteLength(text)} bytes)`);
  }
}

function toEntries(service, plans, source, checked, currency) {
  return plans.map((p) => ({
    id: service.id,
    name: service.name,
    plan: p.plan,
    price: p.price,
    period: p.period ?? 'month',
    perMonth: perMonth(p),
    currency: currency ?? null, // null = the country's own currency
    anime: service.anime ?? 'few',
    url: service.site,
    icon: service.icon ?? null, // the service's own logo; null means the app draws a letter tile
    color: service.color ?? null,
    source,
    checked,
    stale: false,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
