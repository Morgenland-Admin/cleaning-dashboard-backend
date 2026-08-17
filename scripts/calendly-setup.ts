/**
 * Calendly setup + smoke test for pickup appointments. Everything here talks to
 * the live CLEANILO Calendly account, so it is the tool for the one-time setup
 * (finding the event type, registering the webhook) and for proving the
 * integration end-to-end once the token exists.
 *
 *   node --import tsx scripts/calendly-setup.ts <command> [options]
 *
 *     whoami                       token owner + organization URIs
 *     event-types                  every event type with its URI, duration, location kind
 *     available [--days 7]         open start times for CALENDLY_PICKUP_EVENT_TYPE_URI
 *     webhooks                     existing webhook subscriptions
 *     webhook --url <https://…>    register the invitee webhook, prints the signing key
 *     webhook-delete --uri <uri>   remove a webhook subscription
 *     book --slot <YYYY-MM-DDTHH:mm> --email <addr> [--name <name>] [--order <id>] [--phone <nr>]
 *                                  book a real appointment (Berlin wall clock)
 *     cancel --event <uri>         cancel a scheduled event
 *
 * `book` creates a REAL calendar entry and mails the invitee — use a test slot
 * and your own address. Clean up with `cancel`.
 */
import crypto from 'node:crypto';

import { env } from '../src/config/env.ts';
import {
  bookPickupAppointment,
  buildTrackingKey,
  cancelPickupAppointment,
  listAvailablePickupTimes,
  toCalendlyUtc,
} from '../src/lib/calendly.ts';
import { slotToUtc, utcToBerlinSlot } from '../src/modules/orders/calendly-pickup.ts';

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!env.CALENDLY_API_TOKEN) {
  die('CALENDLY_API_TOKEN is not set — put the CLEANILO Personal Access Token in .env first.');
}

const API = 'https://api.calendly.com';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CALENDLY_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) die(`${init.method ?? 'GET'} ${path} → ${res.status}\n${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface CurrentUser {
  resource: { uri: string; name: string; email: string; current_organization: string };
}

async function whoami(): Promise<CurrentUser['resource']> {
  const me = await api<CurrentUser>('/users/me');
  return me.resource;
}

switch (command) {
  case 'whoami': {
    const me = await whoami();
    console.log(`user:         ${me.name} <${me.email}>`);
    console.log(`user URI:     ${me.uri}`);
    console.log(`organization: ${me.current_organization}`);
    break;
  }

  case 'event-types': {
    const me = await whoami();
    const list = await api<{
      collection: {
        uri: string;
        name: string;
        duration: number;
        active: boolean;
        scheduling_url: string;
        locations?: { kind: string; location?: string }[] | null;
      }[];
    }>(`/event_types?user=${encodeURIComponent(me.uri)}&count=100`);
    for (const et of list.collection) {
      const kinds = (et.locations ?? []).map((l) => l.kind).join(', ') || '(none)';
      console.log(`\n${et.name}${et.active ? '' : '  [inactive]'}`);
      console.log(`  URI:           ${et.uri}`);
      console.log(`  duration:      ${et.duration} min`);
      console.log(`  location kind: ${kinds}`);
      console.log(`  page:          ${et.scheduling_url}`);
    }
    console.log(
      '\n→ Put the pickup event type URI in CALENDLY_PICKUP_EVENT_TYPE_URI and its',
      '\n  location kind in CALENDLY_PICKUP_LOCATION_KIND (empty when "(none)").',
    );
    break;
  }

  case 'available': {
    const days = Number(opt('days') ?? 7);
    // Calendly rejects a start in the past and caps the window at 7 days.
    const start = new Date(Date.now() + 60_000);
    const end = new Date(start.getTime() + Math.min(days, 7) * 24 * 3600_000);
    const times = await listAvailablePickupTimes(start, end);
    console.log(
      `${times.length} open slot(s) between ${toCalendlyUtc(start)} and ${toCalendlyUtc(end)}:`,
    );
    for (const t of times) console.log(`  ${t}   (Berlin: ${utcToBerlinSlot(t)})`);
    break;
  }

  case 'webhooks': {
    const me = await whoami();
    const list = await api<{
      collection: { uri: string; callback_url: string; events: string[]; state: string }[];
    }>(
      `/webhook_subscriptions?organization=${encodeURIComponent(me.current_organization)}&scope=organization&count=100`,
    );
    if (list.collection.length === 0) console.log('(no webhook subscriptions)');
    for (const w of list.collection) {
      console.log(`\n${w.callback_url}  [${w.state}]`);
      console.log(`  URI:    ${w.uri}`);
      console.log(`  events: ${w.events.join(', ')}`);
    }
    break;
  }

  case 'webhook': {
    const url = opt('url');
    if (!url)
      die(
        '--url is required, e.g. --url https://api.example.com/storefront/orders/webhook/calendly',
      );
    const me = await whoami();
    // We generate the signing key so it can be printed once and stored in .env.
    const signingKey = crypto.randomBytes(32).toString('hex');
    const created = await api<{ resource: { uri: string; callback_url: string } }>(
      '/webhook_subscriptions',
      {
        method: 'POST',
        body: JSON.stringify({
          url,
          events: ['invitee.created', 'invitee.canceled'],
          organization: me.current_organization,
          scope: 'organization',
          signing_key: signingKey,
        }),
      },
    );
    console.log(`✓ webhook registered: ${created.resource.callback_url}`);
    console.log(`  URI: ${created.resource.uri}`);
    console.log(`\n→ CALENDLY_WEBHOOK_SIGNING_KEY=${signingKey}`);
    console.log('  (shown once — store it in .env / .env.prod now)');
    break;
  }

  case 'webhook-delete': {
    const uri = opt('uri');
    if (!uri) die('--uri is required (see `webhooks`)');
    const uuid = uri.replace(/\/+$/, '').split('/').pop();
    await api(`/webhook_subscriptions/${encodeURIComponent(uuid!)}`, { method: 'DELETE' });
    console.log(`✓ deleted ${uri}`);
    break;
  }

  case 'book': {
    const slot = opt('slot');
    const email = opt('email');
    if (!slot || !email) die('--slot and --email are required');
    const startTime = slotToUtc(slot);
    if (!startTime) die(`--slot must look like 2026-08-12T10:00 (Europe/Berlin), got "${slot}"`);
    const orderId = Number(opt('order') ?? 0) || 999999;
    const booking = await bookPickupAppointment({
      startTime,
      customerName: opt('name') ?? 'Testbuchung Dashboard',
      customerEmail: email,
      customerPhone: opt('phone') ?? '+49 40 123456',
      addressText: 'Teststrasse 1, 20457 Hamburg',
      serviceSummary: 'Testbuchung aus dem Dashboard – bitte ignorieren.',
      trackingKey: buildTrackingKey('cleanilo', orderId),
    });
    console.log(`✓ booked ${slot} (Berlin) = ${toCalendlyUtc(startTime)}`);
    console.log(`  event:      ${booking.eventUri}`);
    console.log(`  invitee:    ${booking.inviteeUri}`);
    console.log(`  status:     ${booking.status}`);
    console.log(`  cancel:     ${booking.cancelUrl}`);
    console.log(`  reschedule: ${booking.rescheduleUrl}`);
    console.log('\n→ Check the CLEANILO Google Calendar now; clean up with:');
    console.log(
      `   node --import tsx scripts/calendly-setup.ts cancel --event ${booking.eventUri}`,
    );
    break;
  }

  case 'cancel': {
    const eventUri = opt('event');
    if (!eventUri) die('--event <scheduled event URI> is required');
    const result = await cancelPickupAppointment(eventUri, 'Testbuchung aufgeräumt');
    if (!result.ok) die(result.error ?? 'cancel failed');
    console.log(`✓ cancelled ${eventUri}`);
    break;
  }

  default:
    console.error('Unknown command. See the header of this file for usage.');
    process.exit(1);
}
