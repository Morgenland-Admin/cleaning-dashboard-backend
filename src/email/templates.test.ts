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

test('CLEANILO confirmation carries the full Widerruf texts for every consented order', async () => {
  const { orderConfirmationEmail } = await import('./templates.js');
  const { withdrawalNoticeFor, TERMS_CONSENT_TEXT } = await import('../lib/legal-texts.js');
  const brand = brandFromSeed(LEGACY_BOOTSTRAP.cleanilo);
  const base = {
    brand,
    customerName: 'Max Muster',
    orderNumber: '2026/000001',
    trackerUrl: 'https://example.test/bestellung?token=x',
    totalFormatted: '100,00 €',
    lines: [{ label: 'Teppichreinigung', quantityLabel: '6 m²', subtotalFormatted: '95,40 €' }],
    fulfillmentNote: 'Wir holen ab.',
  };
  const plain = orderConfirmationEmail(base).html;
  assert.ok(!plain.includes('Widerruf'));
  assert.equal(withdrawalNoticeFor({}, 'cleanilo', 'https://www.cleanilo.de'), null);

  const termsOnly = withdrawalNoticeFor(
    { consents: { termsAcceptedAt: '2026-11-11T14:04:00.000Z' } },
    'cleanilo',
    'https://www.cleanilo.de/',
  );
  assert.ok(termsOnly);
  const html = orderConfirmationEmail({
    ...base,
    appointment: { label: 'Wunschtermin', value: '30.11.2026 · 10:00 Uhr' },
    paymentMethodLabel: 'PayPal',
    withdrawal: termsOnly,
  }).html;
  assert.ok(html.includes(TERMS_CONSENT_TEXT));
  assert.ok(html.includes('Ende der Widerrufsbelehrung'));
  assert.ok(html.includes('Erlöschen des Widerrufsrechts'));
  assert.ok(html.includes('Muster-Widerrufsformular'));
  assert.ok(html.includes('Datum: ______________________'));
  assert.ok(html.includes('https://www.cleanilo.de/agb'));
  assert.ok(
    html.includes('über die Schaltfläche ‚<a href="https://www.cleanilo.de/vertrag-widerrufen"'),
  );
  assert.ok(html.includes('‘ auf cleanilo.de widerrufen.'));
  assert.ok(html.includes('30.11.2026 · 10:00 Uhr'));
  assert.ok(html.includes('Zahlungsart'));
  assert.ok(!html.includes('ausdrücklich verlangt'));

  const early = withdrawalNoticeFor(
    {
      consents: {
        termsAcceptedAt: '2026-11-11T14:04:00.000Z',
        earlyStartAcceptedAt: '2026-11-11T14:04:00.000Z',
      },
    },
    'cleanilo',
    'https://www.cleanilo.de',
  );
  const earlyHtml = orderConfirmationEmail({ ...base, withdrawal: early }).html;
  assert.ok(
    earlyHtml.includes(
      'Sie haben am 11.11.2026, 15:04 Uhr ausdrücklich verlangt, dass wir mit der Ausführung vor Ablauf der Widerrufsfrist beginnen, und bestätigt, dass Sie bei vollständiger Erbringung Ihr Widerrufsrecht verlieren.',
    ),
  );
});

test('other brands keep the early-start-only Widerruf block with a link', async () => {
  const { orderConfirmationEmail } = await import('./templates.js');
  const { withdrawalNoticeFor, EARLY_START_CONSENT_TEXT } = await import('../lib/legal-texts.js');
  const origin = 'https://www.hamburg-teppichreinigung.example';
  assert.equal(
    withdrawalNoticeFor(
      { consents: { termsAcceptedAt: '2026-11-11T14:04:00.000Z' } },
      'hamburg_teppichreinigung',
      origin,
    ),
    null,
  );
  const withdrawal = withdrawalNoticeFor(
    { consents: { earlyStartAcceptedAt: '2026-11-11T14:04:00.000Z' } },
    'hamburg_teppichreinigung',
    origin,
  );
  assert.ok(withdrawal);
  const html = orderConfirmationEmail({
    brand: brandFromSeed(LEGACY_BOOTSTRAP.hamburg_teppichreinigung),
    customerName: 'Max Muster',
    orderNumber: '2026/000001',
    trackerUrl: 'https://example.test/bestellung?token=x',
    totalFormatted: '100,00 €',
    lines: [],
    fulfillmentNote: 'Wir holen ab.',
    withdrawal,
  }).html;
  assert.ok(html.includes('Ihre Zustimmung zum vorzeitigen Leistungsbeginn'));
  assert.ok(html.includes(EARLY_START_CONSENT_TEXT));
  assert.ok(html.includes(`${origin}/widerruf`));
  assert.ok(!html.includes('Ende der Widerrufsbelehrung'));
});

test('withdrawal receipt uses the approved wording with Berlin date and time', async () => {
  const { withdrawalReceiptEmail } = await import('./templates.js');
  const brand = brandFromSeed(LEGACY_BOOTSTRAP.cleanilo);
  const withNumber = withdrawalReceiptEmail({
    brand,
    name: 'Max Muster',
    receivedAt: new Date('2026-11-13T09:05:00.000Z'),
    orderNumber: 'CL-TEST-0001',
    declaration: [
      ['Name', 'Max Muster'],
      ['Auftragsnummer', 'CL-TEST-0001'],
    ],
  });
  assert.equal(withNumber.subject, 'Eingangsbestätigung Ihres Widerrufs — Buchung CL-TEST-0001');
  assert.ok(withNumber.html.includes('Sehr geehrte/r Max Muster,'));
  assert.ok(
    withNumber.html.includes(
      'wir bestätigen den Eingang Ihrer Widerrufserklärung zu Buchung CL-TEST-0001 am <strong>13.11.2026</strong> um <strong>10:05 Uhr</strong>.',
    ),
  );
  assert.ok(
    withNumber.html.includes(
      'Inhalt Ihrer Erklärung: Name: Max Muster; Auftragsnummer: CL-TEST-0001.',
    ),
  );
  assert.ok(
    withNumber.html.includes(
      'Die Rückerstattung bereits geleisteter Zahlungen erfolgt binnen 14 Tagen auf das ursprünglich verwendete Zahlungsmittel.',
    ),
  );
  assert.ok(withNumber.html.includes('Bei Fragen erreichen Sie uns unter '));
  assert.ok(withNumber.html.includes('CLEANILO Madjidian-Amiri GbR'));

  const without = withdrawalReceiptEmail({
    brand,
    name: 'Max Muster',
    receivedAt: new Date('2026-11-13T09:05:00.000Z'),
    declaration: [['Name', 'Max Muster']],
  });
  assert.equal(without.subject, 'Eingangsbestätigung Ihres Widerrufs');
  assert.ok(without.html.includes('Widerrufserklärung zu Ihrer Buchung am'));
});
