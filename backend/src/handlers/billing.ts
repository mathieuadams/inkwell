/**
 * GET  /account            -> plan, usage and storage summary
 * POST /billing/checkout   { plan } -> { url }   Stripe Checkout for a subscription (or the portal if already subscribed)
 * POST /billing/topup      { pages } -> { url }  Stripe Checkout for a one-time page pack (20, 50, 100)
 * POST /billing/portal     -> { url }            Stripe customer portal (change plan, cancel, invoices)
 */
import { handle, HttpError, json, parseBody, userId, type ApiEvent } from '../lib/http';
import { getAccount, saveBilling } from '../lib/account';
import {
  isActiveStatus,
  isPaidPlan,
  isTopupPack,
  productEnvName,
  summary,
  topupEnvName,
  type Billing,
} from '../lib/plans';
import { stripe } from '../lib/stripe';

const LOCAL_ORIGIN = 'http://localhost:5173';
const NOT_READY = "Billing isn't set up yet. Try again later.";

/** Return users to the origin they came from, if it's one of ours. */
function returnOrigin(event: ApiEvent): string {
  const site = process.env.SITE_URL ?? '';
  const origin = event.headers?.origin;
  return origin && [site, LOCAL_ORIGIN].includes(origin) ? origin : site;
}

const priceCache = new Map<string, string>();

/** Each Stripe product's default price is the one we sell. */
async function defaultPrice(envName: string): Promise<string> {
  const cached = priceCache.get(envName);
  if (cached) return cached;
  const productId = process.env[envName];
  if (!productId) throw new HttpError(503, NOT_READY);
  const product = await stripe<{ default_price?: string | { id: string } | null; active: boolean }>(
    'GET',
    `/v1/products/${encodeURIComponent(productId)}`,
  );
  const price = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
  if (!price || !product.active) {
    console.error('Stripe product has no active default price', envName, productId);
    throw new HttpError(503, NOT_READY);
  }
  priceCache.set(envName, price);
  return price;
}

async function ensureCustomer(sub: string, billing: Billing): Promise<string> {
  if (billing.customerId) return billing.customerId;
  const customer = await stripe<{ id: string }>('POST', '/v1/customers', { metadata: { sub } });
  await saveBilling(sub, { ...billing, customerId: customer.id });
  return customer.id;
}

async function portalUrl(customerId: string, origin: string): Promise<string> {
  const session = await stripe<{ url: string }>('POST', '/v1/billing_portal/sessions', {
    customer: customerId,
    return_url: `${origin}/?billing=portal`,
  });
  return session.url;
}

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { billing, usage, credits } = await getAccount(sub);
  const origin = returnOrigin(event);

  switch (event.routeKey) {
    case 'GET /account':
      return json(200, summary(billing, usage, process.env, credits));

    case 'POST /billing/checkout': {
      const { plan } = parseBody<{ plan: string }>(event);
      if (!isPaidPlan(plan)) throw new HttpError(400, 'Choose Starter, Plus or Pro.');

      // Already subscribed: plan changes go through the portal so Stripe prorates correctly.
      if (billing.customerId && billing.subscriptionId && isActiveStatus(billing.status)) {
        return json(200, { url: await portalUrl(billing.customerId, origin) });
      }

      const price = await defaultPrice(productEnvName(plan));
      const customer = await ensureCustomer(sub, billing);
      const session = await stripe<{ url: string }>('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: sub,
        line_items: [{ price, quantity: 1 }],
        subscription_data: { metadata: { sub } },
        allow_promotion_codes: true,
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancel`,
      });
      return json(200, { url: session.url });
    }

    case 'POST /billing/topup': {
      const { pages } = parseBody<{ pages: number }>(event);
      if (!isTopupPack(pages)) throw new HttpError(400, 'Choose a pack of 20, 50 or 100 pages.');
      const price = await defaultPrice(topupEnvName(pages));
      const customer = await ensureCustomer(sub, billing);
      const session = await stripe<{ url: string }>('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        customer,
        client_reference_id: sub,
        line_items: [{ price, quantity: 1 }],
        metadata: { sub, kind: 'topup', pages },
        payment_intent_data: { metadata: { sub, kind: 'topup', pages } },
        invoice_creation: { enabled: true },
        success_url: `${origin}/?billing=topup`,
        cancel_url: `${origin}/?billing=cancel`,
      });
      return json(200, { url: session.url });
    }

    case 'POST /billing/portal': {
      if (!billing.customerId) throw new HttpError(400, "You don't have a subscription yet.");
      return json(200, { url: await portalUrl(billing.customerId, origin) });
    }

    default:
      throw new HttpError(404, 'Not found.');
  }
});
