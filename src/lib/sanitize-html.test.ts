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

test('keeps text-align from the editor but no other inline style', () => {
  const out = sanitizeHtml(
    '<p style="text-align: center; color: red; background: url(x)">x</p><h2 style="position:fixed">y</h2>',
  );
  assert.equal(out, '<p style="text-align:center">x</p><h2>y</h2>');
});

test('rejects text-align values outside the allowlist', () => {
  assert.equal(sanitizeHtml('<p style="text-align: expression(alert(1))">x</p>'), '<p>x</p>');
});

test('keeps editor tables, underline and images intact', () => {
  const html =
    '<table><tbody><tr><th colspan="1" rowspan="1"><p>A</p></th></tr><tr><td colspan="2" rowspan="1"><p><u>b</u></p></td></tr></tbody></table><img src="https://cdn.example.com/a.webp" alt="Teppich" />';
  assert.equal(sanitizeHtml(html), html);
});
