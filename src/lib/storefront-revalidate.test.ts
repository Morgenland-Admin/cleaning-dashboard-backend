import assert from 'node:assert/strict';
import { test } from 'node:test';

import { publicPathsFor } from './storefront-revalidate.js';

test('a blog post revalidates its article and the /blog index', () => {
  assert.deepEqual(publicPathsFor({ type: 'blog', path: 'blog/kelim', category: null }), [
    '/blog',
    '/blog/kelim',
  ]);
});

test('an overlay row revalidates its fixed storefront route, not /seo/', () => {
  assert.deepEqual(
    publicPathsFor({ type: 'service', path: 'leistungen/fleckenentfernung', category: 'leistung' }),
    ['/leistungen/fleckenentfernung'],
  );
});

test('service and city pages render under /seo/', () => {
  assert.deepEqual(publicPathsFor({ type: 'city', path: 'altona', category: null }), [
    '/seo/altona',
  ]);
});
