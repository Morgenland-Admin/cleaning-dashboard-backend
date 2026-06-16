import { env } from '../config/env.js';

/**
 * Native PayPal Orders v2 client. Money settles into the PayPal business account,
 * so these orders cannot be paid out to partners via Stripe Connect.
 */

export const paypalConfigured = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);

const API_BASE =
  env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

function assertConfigured(): void {
  if (!paypalConfigured) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_SECRET are not configured.');
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  assertConfigured();
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;

  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PayPal token request failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: now + Math.max(0, json.expires_in - 60) * 1000,
  };
  return json.access_token;
}

async function paypalFetch<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.idempotencyKey) headers['PayPal-Request-Id'] = init.idempotencyKey;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const detail =
      (body as { message?: string; details?: { description?: string }[] })?.message ??
      (body as { details?: { description?: string }[] })?.details?.[0]?.description ??
      text;
    const err = new Error(
      `PayPal ${init.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body as T;
}

export interface PayPalCreatedOrder {
  id: string;
  status: string;
}

/** Create a PayPal order for `amountCents` EUR. `invoiceId` blocks an accidental double-pay. */
export async function createPayPalOrder(args: {
  amountCents: number;
  referenceId: string;
  invoiceId: string;
  description?: string;
  brandName?: string;
  idempotencyKey: string;
}): Promise<PayPalCreatedOrder> {
  const value = (args.amountCents / 100).toFixed(2);
  return paypalFetch<PayPalCreatedOrder>('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: args.idempotencyKey,
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: args.referenceId,
          invoice_id: args.invoiceId,
          description: args.description?.slice(0, 127),
          amount: { currency_code: 'EUR', value },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: args.brandName?.slice(0, 127),
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
          },
        },
      },
    }),
  });
}

export interface PayPalCapture {
  id: string;
  /** Order-level status (e.g. COMPLETED). */
  status: string;
  /** Capture-level status of the resolved capture — only COMPLETED means money received. */
  captureStatus: string | null;
  captureId: string | null;
  amountCents: number | null;
  currency: string | null;
  referenceId: string | null;
  invoiceId: string | null;
}

interface RawCaptureResponse {
  id: string;
  status: string;
  purchase_units?: {
    reference_id?: string;
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount?: { currency_code: string; value: string };
        invoice_id?: string;
      }[];
    };
  }[];
}

function normalizeCapture(raw: RawCaptureResponse): PayPalCapture {
  const unit = raw.purchase_units?.[0];
  const cap =
    unit?.payments?.captures?.find((c) => c.status === 'COMPLETED') ??
    unit?.payments?.captures?.[0];
  const value = cap?.amount?.value;
  return {
    id: raw.id,
    status: raw.status,
    captureStatus: cap?.status ?? null,
    captureId: cap?.id ?? null,
    amountCents: value != null ? Math.round(parseFloat(value) * 100) : null,
    currency: cap?.amount?.currency_code ?? null,
    referenceId: unit?.reference_id ?? null,
    invoiceId: cap?.invoice_id ?? null,
  };
}

/** Capture a previously-approved PayPal order. Idempotent via PayPal-Request-Id. */
export async function capturePayPalOrder(
  paypalOrderId: string,
  idempotencyKey: string,
): Promise<PayPalCapture> {
  const raw = await paypalFetch<RawCaptureResponse>(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    { method: 'POST', idempotencyKey, body: '{}' },
  );
  return normalizeCapture(raw);
}

/** Read a PayPal order. */
export async function getPayPalOrder(paypalOrderId: string): Promise<PayPalCapture> {
  const raw = await paypalFetch<RawCaptureResponse>(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    { method: 'GET' },
  );
  return normalizeCapture(raw);
}

export interface PayPalWebhookHeaders {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
}

/** Verify a webhook signature via PayPal's API. Returns false rather than throwing. */
export async function verifyPayPalWebhook(
  headers: PayPalWebhookHeaders,
  rawBody: string,
): Promise<boolean> {
  if (!paypalConfigured || !env.PAYPAL_WEBHOOK_ID) return false;
  if (
    !headers.transmissionId ||
    !headers.transmissionTime ||
    !headers.transmissionSig ||
    !headers.certUrl ||
    !headers.authAlgo
  ) {
    return false;
  }
  try {
    const payload =
      `{"auth_algo":${JSON.stringify(headers.authAlgo)},` +
      `"cert_url":${JSON.stringify(headers.certUrl)},` +
      `"transmission_id":${JSON.stringify(headers.transmissionId)},` +
      `"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
      `"transmission_time":${JSON.stringify(headers.transmissionTime)},` +
      `"webhook_id":${JSON.stringify(env.PAYPAL_WEBHOOK_ID)},` +
      `"webhook_event":${rawBody}}`;
    const result = await paypalFetch<{ verification_status: string }>(
      '/v1/notifications/verify-webhook-signature',
      { method: 'POST', body: payload },
    );
    return result.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
