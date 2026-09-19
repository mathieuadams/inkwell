/**
 * GET  /account            -> plan, usage and storage summary
 * POST /billing/checkout   { plan } -> { url }  Stripe Checkout (or the portal if already subscribed)
 * POST /billing/portal     -> { url }           Stripe customer portal (change plan, cancel, invoices)
 */
import { handle, HttpError, json, parseBody, userId, type ApiEvent } from '../lib/http';
import { getBilling, getUsage, saveBilling } from '../lib/account';
import { isActiveStatus, isPaidPlan, priceEnvName, summary } from '../lib/plans';
import { stripe } from '../lib/stripe';

const LOCAL_ORIGIN = 'http://localhost:5173';

/** Return users to the origin they came from, if it's one of ours. */
function returnOrigin(event: ApiEvent): string {
  const site = process.env.SITE_URL ?? '';
  const origin = event.headers?.origin;
  return origin && [site, LOCAL_ORIGIN].includes(origin) ? origin : site;
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
  const billing = await getBilling(sub);

  switch (event.routeKey) {
    case 'GET /account':
      return json(200, summary(billing, await getUsage(sub)));

    case 'POST /billing/checkout': {
      const { plan } = parseBody<{ plan: string }>(event);
      if (!isPaidPlan(plan)) throw new HttpError(400, 'Choose Starter, Plus or Pro.');
      const price = process.env[priceEnvName(plan)];
      if (!price) throw new HttpError(503, "Billing isn't set up yet. Try again later.");
      const origin = returnOrigin(event);

      // Already subscribed: plan changes go through the portal so Stripe prorates correctly.
      if (billing.customerId && billing.subscriptionId && isActiveStatus(billing.status)) {
        return json(200, { url: await portalUrl(billing.customerId, origin) });
      }

      let customerId = billing.customerId;
      if (!customerId) {
        const customer = await stripe<{ id: string }>('POST', '/v1/customers', { metadata: { sub } });
        customerId = customer.id;
        await saveBilling(sub, { ...billing, customerId });
      }

      const session = await stripe<{ url: string }>('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: sub,
        line_items: [{ price, quantity: 1 }],
        subscription_data: { metadata: { sub } },
        allow_promotion_codes: true,
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancel`,
      });
      return json(200, { url: session.url });
    }

    case 'POST /billing/portal': {
      if (!billing.customerId) throw new HttpError(400, "You don't have a subscription yet.");
      return json(200, { url: await portalUrl(billing.customerId, returnOrigin(event)) });
    }

    default:
      throw new HttpError(404, 'Not found.');
  }
});
