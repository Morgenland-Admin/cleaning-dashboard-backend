import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_BOOTSTRAP, type LegacyConfig } from '../db/bootstrap-companies.js';
import { brandInfoFromCompany } from './service.js';
import { contactReplyEmail, inquiryQuoteEmail, orderMessageEmail } from './templates.js';

// Guards the rule Kabir asked for: mail an operator sends from the dashboard
// (contact reply, offer, order message) signs as the BRAND — the signatory
// configured on the company row — and never as the logged-in dashboard user
// ("Admin"). The operator's name stays in the internal audit log only.

/** The subset of the company row the brand templates read, from the boot seed. */
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

/** The three operator-composed customer mails, rendered for one brand. */
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
  };
}

for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
  test(`${cfg.slug}: operator mail signs with the brand signature`, () => {
    // Every brand must carry a seeded sign-off — the derived fallback exists for
    // brands created later, not for the three legacy ones.
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
      // The brand's own name and the GbR's legal name still appear (header /
      // Pflichtangaben footer), but no dashboard login name may show up.
      for (const operator of ['Admin', 'Rohan']) {
        assert.ok(!html.includes(operator), `${kind} leaks the operator name "${operator}"`);
      }
    }
  });
}

test('a brand with no configured signature signs as its own team, not the operator', () => {
  // Simulates a company created via POST /admin/companies before anyone seeded
  // an email_signature for it.
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
