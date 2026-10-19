import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_BOOTSTRAP, type LegacyConfig } from '../db/bootstrap-companies.js';
import { brandInfoFromCompany } from './service.js';
import {
  contactReplyEmail,
  customerMessageEmail,
  formalGreeting,
  inquiryQuoteEmail,
  orderMessageEmail,
} from './templates.js';

// Operator-sent mail signs as the brand's configured signatory, never as the dashboard user ("Admin").

function brandFromSeed(cfg: LegacyConfig) {
  return brandInfoFromCompany({
    name: cfg.name,
    senderEmail: cfg.senderEmail,
    senderName: cfg.senderName,
    email: cfg.senderEmail,
    phone: cfg.phone ?? null,
    websiteUrl: cfg.websiteUrl,
    logoUrl: cfg.logoUrl,
    primaryColor: cfg.primaryColor ?? null,
    emailSignature: cfg.emailSignature ?? null,
    legalName: cfg.legal?.legalName ?? null,
    addressLine1: cfg.legal?.addressLine1 ?? null,
    postalCode: cfg.legal?.postalCode ?? null,
    city: cfg.legal?.city ?? null,
    vatId: cfg.legal?.vatId ?? null,
  });
}

function operatorMails(cfg: LegacyConfig): Record<string, string> {
  const brand = brandFromSeed(cfg);
  return {
    order_message: orderMessageEmail({
      brand,
      customerName: 'Frau Beispiel',
      orderNumber: 'CL-1001',
      messageBody: 'Ihr Teppich ist fertig.',
      trackerUrl: 'https://example.test/bestellung?token=x',
    }).html,
    contact_reply: contactReplyEmail({
      brand,
      recipientName: 'Frau Beispiel',
      replyBody: 'Gerne, wir melden uns.',
    }).html,
    inquiry_quote: inquiryQuoteEmail({
      brand,
      recipientName: 'Frau Beispiel',
      quoteBody: 'Reinigung von 2 Teppichen.',
      quotedAmount: '180,00 €',
    }).html,
    customer_message: customerMessageEmail({
      brand,
      recipient: { salutation: 'frau', lastName: 'Beispiel' },
      subject: 'Ihr Termin',
      messageBody: 'Wir melden uns morgen.',
    }).html,
  };
}

for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
  test(`${cfg.slug}: operator mail signs with the brand signature`, () => {
    // The derived fallback is for later-created brands; the three legacy ones must be seeded.
    const sig = cfg.emailSignature;
    assert.ok(sig, `${cfg.slug} has no emailSignature in the boot seed`);
    const signatory = sig.signatory;
    assert.ok(signatory, `${cfg.slug} signature has no signatory`);

    for (const [kind, html] of Object.entries(operatorMails(cfg))) {
      assert.ok(html.includes(signatory), `${kind} does not sign as ${signatory}`);
      assert.ok(
        html.includes(sig.signOff ?? 'Mit freundlichen Grüßen'),
        `${kind} has no closing line`,
      );
      // Brand and GbR legal names may appear; operator login names may not.
      for (const operator of ['Admin', 'Rohan']) {
        assert.ok(!html.includes(operator), `${kind} leaks the operator name "${operator}"`);
      }
    }
  });
}

test('a brand with no configured signature signs as its own team, not the operator', () => {
  // Company created via POST /admin/companies before any email_signature was seeded.
  const brand = brandInfoFromCompany({
    name: 'Neue Marke',
    senderEmail: 'info@neue-marke.de',
    senderName: 'Neue Marke',
    email: 'info@neue-marke.de',
    phone: '+49 40 000 000',
    websiteUrl: 'https://www.neue-marke.de',
    addressLine1: 'Brook 9',
    postalCode: '20457',
    city: 'Hamburg',
    emailSignature: null,
  });

  const html = contactReplyEmail({
    brand,
    recipientName: 'Frau Beispiel',
    replyBody: 'Gerne, wir melden uns.',
  }).html;

  assert.ok(html.includes('Ihr Team von Neue Marke'));
  assert.ok(html.includes('Mit freundlichen Grüßen'));
  assert.ok(html.includes('+49 40 000 000'));
  assert.ok(html.includes('www.neue-marke.de'));
  assert.ok(html.includes('Zentrale: Brook 9, 20457 Hamburg'));
  assert.ok(!html.includes('Admin'));
});

test('customer mail greets formally and never invents a name', () => {
  assert.equal(
    formalGreeting({ salutation: 'herr', lastName: 'Muster' }),
    'Sehr geehrter Herr Muster,',
  );
  assert.equal(
    formalGreeting({ salutation: 'frau', lastName: 'Muster' }),
    'Sehr geehrte Frau Muster,',
  );
  assert.equal(
    formalGreeting({ salutation: 'firma', name: 'ACME GmbH' }),
    'Sehr geehrte Damen und Herren,',
  );
  assert.equal(formalGreeting({ firstName: 'Anna', lastName: 'Muster' }), 'Guten Tag Anna Muster,');
  assert.equal(formalGreeting({ name: null }), 'Guten Tag,');
});
