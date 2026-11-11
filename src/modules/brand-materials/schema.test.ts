import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { brandMaterialDraftDataSchema, templatePathSchema, upsertDraftSchema } from './schema.js';

describe('brand material draft schema', () => {
  it('accepts the allowed template paths', () => {
    for (const p of ['_brand', 'kunden/visitenkarte', 'partner/flyer-a5', 'system/designsystem']) {
      assert.equal(templatePathSchema.safeParse(p).success, true, p);
    }
  });

  it('rejects other template paths', () => {
    for (const p of [
      '',
      'brand',
      'kunden/',
      'kunden/Flyer',
      'kunden/../x',
      'system/other',
      'x/y',
    ]) {
      assert.equal(templatePathSchema.safeParse(p).success, false, p);
    }
  });

  it('accepts a full payload', () => {
    const data = {
      edits: { 'Original text': 'New text' },
      values: { phone: '040 123' },
      qr: { '0': 'https://example.com' },
      images: { '0': 'https://cdn.example.com/a.jpg', '1': 'http://localhost:9000/b/c.png' },
      links: { booking: 'https://example.com/book' },
      utm: true,
    };
    assert.deepEqual(brandMaterialDraftDataSchema.parse(data), data);
    assert.deepEqual(brandMaterialDraftDataSchema.parse({}), {});
  });

  it('rejects unknown keys', () => {
    assert.equal(brandMaterialDraftDataSchema.safeParse({ other: 1 }).success, false);
  });

  it('rejects non-https image URLs', () => {
    for (const url of [
      'http://example.com/a.jpg',
      'http://localhost.evil.com/a.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ]) {
      assert.equal(brandMaterialDraftDataSchema.safeParse({ images: { '0': url } }).success, false);
    }
    assert.equal(
      brandMaterialDraftDataSchema.safeParse({ images: { '0': 'http://127.0.0.1/x.png' } }).success,
      true,
    );
  });

  it('caps record size and key length', () => {
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, 'v']));
    assert.equal(brandMaterialDraftDataSchema.safeParse({ values: many }).success, false);
    assert.equal(
      brandMaterialDraftDataSchema.safeParse({ qr: { ['x'.repeat(21)]: 'v' } }).success,
      false,
    );
  });

  it('requires an ISO expectedUpdatedAt when given', () => {
    const base = { templatePath: '_brand', data: {} };
    assert.equal(upsertDraftSchema.safeParse(base).success, true);
    assert.equal(
      upsertDraftSchema.safeParse({ ...base, expectedUpdatedAt: '2026-11-12T10:00:00.123Z' })
        .success,
      true,
    );
    assert.equal(
      upsertDraftSchema.safeParse({ ...base, expectedUpdatedAt: 'yesterday' }).success,
      false,
    );
  });
});
