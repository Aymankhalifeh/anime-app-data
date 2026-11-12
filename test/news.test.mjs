// Tests for the news job: node --test   (built into Node, nothing to install)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRss, titleCandidates, pick } from '../scripts/news.mjs';

test('headline -> anime name', () => {
  const cases = {
    "Crunchyroll to Stream Dragon Ball Super: Beerus Anime's English Dub on November 12": 'Dragon Ball Super: Beerus',
    "The Dangers in My Heart Season 3 Anime's Teaser Trailer Reveals April 2027 Premiere": 'The Dangers in My Heart',
    "OceanVeil Streams English Dub of Even the Student Council Has It's Holes! Anime": "Even the Student Council Has It's Holes!",
    "Fool Night Anime's Trailer Reveals Theme Songs, Additional Cast": 'Fool Night',
    'Senren * Banka Anime Reveals TV Format': 'Senren * Banka',
    "Satoshi Mizukami's Spirit Circle Manga Gets TV Anime in December": 'Spirit Circle',
    'New Code Geass Star Chaser Aspal Anime Unveils Cast, More Staff': 'Code Geass Star Chaser Aspal',
    'Reincarnated as a Sword Season 2 Anime Reveals Trailer': 'Reincarnated as a Sword',
  };
  for (const [headline, name] of Object.entries(cases)) {
    assert.equal(titleCandidates(headline)[0], name, headline);
  }
});

test('headlines that are not about one anime give no name', () => {
  assert.deepEqual(titleCandidates("A Few Moments of Cheers' Studio Hurray! Animates Wondering Mate Net Shorts"), []);
});

test('only an exact name counts, the series itself before later seasons', () => {
  const media = [
    { id: 2, title: { english: 'The Dangers in My Heart Season 2' }, synonyms: [] },
    { id: 1, title: { english: 'The Dangers in My Heart', romaji: 'Boku no Kokoro no Yabai Yatsu' }, synonyms: [] },
  ];
  assert.equal(pick('The Dangers in My Heart', media).id, 1);
  assert.equal(pick('Boku no Kokoro no Yabai Yatsu', media).id, 1); // romaji counts
  assert.equal(pick('Dangers', media), null); // too vague
  assert.equal(pick('Senren * Banka', [{ id: 3, title: { romaji: 'Senren＊Banka' } }]).id, 3); // odd stars
});

test('RSS: headline, link and time; HTML and entities cleaned', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Frieren Anime&#039;s Season 2 &amp; More]]></title>
      <link>https://www.animenewsnetwork.com/news/1</link><guid>g1</guid>
      <pubDate>Thu, 05 Nov 2026 18:00:00 -0500</pubDate><category>Anime</category>
      <description><![CDATA[<p>The <b>second</b> season premieres in January.</p>]]></description></item>
    <item><title>No link</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1); // the item without an https link is dropped
  assert.equal(items[0].title, "Frieren Anime's Season 2 & More");
  assert.equal(items[0].link, 'https://www.animenewsnetwork.com/news/1');
  assert.equal(items[0].time, '2026-11-05T23:00:00.000Z');
  assert.equal(items[0].teaser, 'The second season premieres in January.');
  assert.deepEqual(items[0].categories, ['anime']);
});
