import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureJsonLdDatePublished, setJsonLdImage } from './jsonld.js';

const NOW = '2026-10-09T10:00:00.000Z';

test('ensureJsonLdDatePublished stamps a missing date onto the Article node', () => {
  const out = ensureJsonLdDatePublished({ '@type': 'Article', headline: 'x' }, NOW);
  assert.deepEqual(out, { '@type': 'Article', headline: 'x', datePublished: NOW });
});

test('ensureJsonLdDatePublished leaves an existing date alone', () => {
  const schema = { '@type': 'Article', datePublished: '2026-08-15' };
  assert.equal(ensureJsonLdDatePublished(schema, NOW), null);
});

test('ensureJsonLdDatePublished targets the Article node inside a graph array', () => {
  const out = ensureJsonLdDatePublished(
    [{ '@type': 'BreadcrumbList' }, { '@type': 'BlogPosting', headline: 'x' }],
    NOW,
  ) as Array<Record<string, unknown>>;
  assert.equal(out[1]!.datePublished, NOW);
  assert.equal(out[0]!.datePublished, undefined);
});

test('ensureJsonLdDatePublished creates an Article node when there is no schema', () => {
  assert.deepEqual(ensureJsonLdDatePublished(null, NOW), {
    '@type': 'Article',
    datePublished: NOW,
  });
});

test('setJsonLdImage keeps the rest of the Article node', () => {
  const out = setJsonLdImage({ '@type': 'Article', headline: 'x' }, 'https://cdn/a.webp');
  assert.deepEqual(out, { '@type': 'Article', headline: 'x', image: 'https://cdn/a.webp' });
});
