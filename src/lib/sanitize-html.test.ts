import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from './sanitize-html.js';

test('keeps internal links dofollow so SEO internal linking survives', () => {
  const out = sanitizeHtml('<p><a href="/leistungen/fleckenentfernung/">Fleckenentfernung</a></p>');
  assert.equal(out, '<p><a href="/leistungen/fleckenentfernung/">Fleckenentfernung</a></p>');
  assert.ok(!out.includes('nofollow'));
});

test('marks outbound links noopener/noreferrer/nofollow', () => {
  const out = sanitizeHtml('<a href="https://example.com">x</a>');
  assert.ok(out.includes('rel="noopener noreferrer nofollow"'));
});

test('drops scripts and event handlers', () => {
  assert.equal(sanitizeHtml('<script>alert(1)</script><p onclick="x()">hi</p>'), '<p>hi</p>');
});

test('drops javascript: hrefs', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(!out.includes('javascript:'));
});
