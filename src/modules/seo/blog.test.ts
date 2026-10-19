import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blogMetaSchema,
  copyPath,
  missingForPublish,
  normalizeMeta,
  publicMeta,
  suggestPath,
  withoutPublishDates,
} from './blog.js';

describe('blogMetaSchema + normalizeMeta', () => {
  it('drops empty values and false noindex', () => {
    const meta = normalizeMeta(
      blogMetaSchema.parse({
        excerpt: '  Kurz  ',
        noindex: false,
        canonicalUrl: '',
        ogTitle: '   ',
        imageAlt: 'Perserteppich nach der Wäsche',
      }),
    );
    assert.deepEqual(meta, { excerpt: 'Kurz', imageAlt: 'Perserteppich nach der Wäsche' });
  });

  it('keeps noindex when true', () => {
    assert.deepEqual(normalizeMeta(blogMetaSchema.parse({ noindex: true })), { noindex: true });
  });

  it('rejects non-http canonical and image URLs', () => {
    assert.equal(blogMetaSchema.safeParse({ canonicalUrl: 'javascript:alert(1)' }).success, false);
    assert.equal(blogMetaSchema.safeParse({ ogImage: 'ftp://x.de/a.jpg' }).success, false);
    assert.equal(blogMetaSchema.safeParse({ canonicalUrl: 'https://x.de/a/' }).success, true);
  });

  it('strips unknown keys', () => {
    assert.deepEqual(normalizeMeta(blogMetaSchema.parse({ keywords: 'a,b' })), {});
  });
});

describe('publicMeta', () => {
  it('never exposes the focus keyphrase', () => {
    assert.deepEqual(publicMeta({ focusKeyphrase: 'teppich', noindex: true }), { noindex: true });
    assert.deepEqual(publicMeta(null), {});
  });
});

describe('missingForPublish', () => {
  it('requires a title and visible body text', () => {
    assert.deepEqual(missingForPublish({ title: ' ', bodyHtml: '<p>&nbsp;</p>' }), [
      'title',
      'body',
    ]);
    assert.deepEqual(missingForPublish({ title: 'Titel', bodyHtml: '<p>Text</p>' }), []);
  });
});

describe('copyPath / suggestPath', () => {
  it('appends -kopie, then numbers', () => {
    assert.equal(copyPath('blog/a', new Set()), 'blog/a-kopie');
    assert.equal(copyPath('blog/a', new Set(['blog/a-kopie'])), 'blog/a-kopie-2');
    // Copying a copy does not stack suffixes.
    assert.equal(copyPath('blog/a-kopie', new Set(['blog/a-kopie'])), 'blog/a-kopie-2');
  });

  it('suggests the next free number', () => {
    assert.equal(suggestPath('blog/a', new Set(['blog/a', 'blog/a-2'])), 'blog/a-3');
  });
});

describe('withoutPublishDates', () => {
  it('removes dates from every node, keeps the rest', () => {
    assert.deepEqual(
      withoutPublishDates([
        { '@type': 'BlogPosting', datePublished: '2026-01-01', image: 'x' },
        { '@type': 'Thing', dateModified: '2026-01-02' },
      ]),
      [{ '@type': 'BlogPosting', image: 'x' }, { '@type': 'Thing' }],
    );
    assert.equal(withoutPublishDates(null), null);
  });
});
