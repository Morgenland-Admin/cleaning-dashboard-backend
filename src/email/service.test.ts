import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonContactableEmail, isOwnDomainEmail } from './service.js';

// isOwnDomainEmail is the backend half of the feedback-loop guard: an inquiry
// whose contact address is one of our own brand domains is treated as loop
// traffic and never gets confirmation/notification mail. These assume the env
// default OWN_EMAIL_DOMAINS list.
test('isOwnDomainEmail matches our own brand domains', () => {
  assert.equal(isOwnDomainEmail('info@cleanilo.de'), true);
  assert.equal(isOwnDomainEmail('no-reply@hamburg-teppichreinigung.de'), true);
  assert.equal(isOwnDomainEmail('kontakt@teppichreinigen-lassen.de'), true);
  assert.equal(isOwnDomainEmail('admin@reinigungs-portal.com'), true);
});

test('isOwnDomainEmail is case- and whitespace-insensitive', () => {
  assert.equal(isOwnDomainEmail('  Info@Cleanilo.DE '), true);
});

test('isOwnDomainEmail matches subdomains of an own domain', () => {
  assert.equal(isOwnDomainEmail('bounce@mail.cleanilo.de'), true);
});

test('isOwnDomainEmail rejects external and malformed addresses', () => {
  assert.equal(isOwnDomainEmail('kunde@gmail.com'), false);
  // Guards against a naive endsWith: a lookalike suffix must not match.
  assert.equal(isOwnDomainEmail('attacker@evilcleanilo.de'), false);
  assert.equal(isOwnDomainEmail('cleanilo.de'), false); // no @ ⇒ empty domain
  assert.equal(isOwnDomainEmail(''), false);
  assert.equal(isOwnDomainEmail(null), false);
  assert.equal(isOwnDomainEmail(undefined), false);
});

test('isNonContactableEmail still flags synthetic import placeholders', () => {
  assert.equal(isNonContactableEmail('someone@import.cleanilo.local'), true);
  assert.equal(isNonContactableEmail('real@cleanilo.de'), false);
});
