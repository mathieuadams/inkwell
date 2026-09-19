/** POST /stripe/webhook  (no JWT; authenticated by the Stripe-Signature header) */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { requireEnv } from '../lib/http';
import { getBilling, saveBilling } from '../lib/account';
import { applySubscription, parseSubscription, shouldApply } from '../lib/plans';
import { getSecret, stripe } from '../lib/stripe';
import { verifyStripeSignature } from '../lib/stripe-utils';
import { isNoteId as isUuid } from '../lib/validation';

const reply = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({ statusCode, body });

/** Always re-reads the subscription from Stripe, so out-of-order events can't leave stale state. */
async function sync(subscriptionId: string, hintSub?: string | null) {
  const obj = await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  let sub: unknown = obj.metadata?.sub || hintSub;
  if (!isUuid(sub) && obj.customer) {
    const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer.id;
    const customer = await stripe('GET', `/v1/customers/${encodeURIComponent(customerId)}`);
    sub = customer.metadata?.sub;
  }
  if (!isUuid(sub)) {
    console.warn('Subscription has no Inkwell user', subscriptionId);
    return;
  }
  const state = parseSubscription(obj);
  const prev = await getBilling(sub);
  if (!shouldApply(prev, state)) {
    console.info('Ignoring stale subscription event', subscriptionId);
    return;
  }
  const next = applySubscription(prev, state);
  await saveBilling(sub, next);
  console.info('Billing updated', JSON.stringify({ sub, plan: next.plan, status: next.status }));
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  let secret: string;
  try {
    secret = await getSecret(requireEnv('STRIPE_WEBHOOK_PARAM'));
  } catch {
    return reply(500, 'Webhook secret not configured');
  }
  if (!verifyStripeSignature(raw, event.headers?.['stripe-signature'], secret)) return reply(400, 'Invalid signature');

  try {
    const evt = JSON.parse(raw);
    const obj = evt?.data?.object ?? {};
    switch (evt.type) {
      case 'checkout.session.completed':
        if (obj.mode === 'subscription' && obj.subscription) {
          await sync(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id, obj.client_reference_id);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await sync(obj.id);
        break;
      default:
        break; // acknowledged, not used
    }
    return reply(200, 'ok');
  } catch (err) {
    console.error('Webhook handling failed', err);
    return reply(500, 'error'); // Stripe retries
  }
};
