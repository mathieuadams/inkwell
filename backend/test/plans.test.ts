import { describe, expect, it } from 'vitest';
import {
  applySubscription,
  checkAllowance,
  effectivePlan,
  limits,
  newBilling,
  newUsage,
  parseSubscription,
  planFromPrice,
  recordUsage,
  retentionCutoff,
  shouldApply,
  storesNotes,
  summary,
  type Billing,
} from '../src/lib/plans';

const ENV = { STRIPE_PRICE_STARTER: 'price_s', STRIPE_PRICE_PLUS: 'price_p', STRIPE_PRICE_PRO: 'price_x', FREE_PAGES: '3' };
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-20T12:00:00Z');
const paid = (plan: Billing['plan'], extra: Partial<Billing> = {}): Billing => ({
  plan, status: 'active', subscriptionId: 'sub_1', customerId: 'cus_1', periodStart: 1000, periodEnd: 2000, ...extra,
});

describe('plans and quotas', () => {
  it('falls back to free unless the subscription is active', () => {
    expect(effectivePlan(newBilling())).toBe('free');
    expect(effectivePlan(paid('plus'))).toBe('plus');
    expect(effectivePlan(paid('plus', { status: 'past_due' }))).toBe('plus');
    expect(effectivePlan(paid('plus', { status: 'canceled' }))).toBe('free');
  });

  it('applies the monthly page limits', () => {
    expect(limits(paid('starter'), newUsage(), ENV).pagesLimit).toBe(20);
    expect(limits(paid('plus'), newUsage(), ENV).pagesLimit).toBe(150);
    expect(limits(paid('pro'), newUsage(), ENV).pagesLimit).toBe(500);
    expect(limits(newBilling(), newUsage(), ENV).pagesLimit).toBe(3);
    expect(limits(newBilling(), newUsage(), { ...ENV, FREE_PAGES: '0' }).pagesLimit).toBe(0);
  });

  it('blocks pages over quota with a helpful message', () => {
    const b = paid('starter');
    const full = { ...newUsage(), period: 1000, pages: 20 };
    expect(checkAllowance(b, full, 'page', ENV)).toMatch(/all 20 pages/);
    expect(checkAllowance(b, { ...full, pages: 19 }, 'page', ENV)).toBeNull();
    expect(checkAllowance(newBilling(), { ...newUsage(), freePages: 3 }, 'page', ENV)).toMatch(/3 free pages/);
    expect(checkAllowance(newBilling(), newUsage(), 'page', { ...ENV, FREE_PAGES: '0' })).toMatch(/Choose a plan/);
  });

  it('resets usage when a new billing period starts', () => {
    const b = paid('plus');
    let u = recordUsage(b, newUsage(), 'page');
    u = recordUsage(b, u, 'page');
    expect(u).toMatchObject({ period: 1000, pages: 2 });
    const renewed = { ...b, periodStart: 3000 };
    expect(limits(renewed, u, ENV).pagesUsed).toBe(0);
    expect(recordUsage(renewed, u, 'page')).toMatchObject({ period: 3000, pages: 1, translations: 0 });
  });

  it('counts free usage separately and for life', () => {
    const u = recordUsage(newBilling(), recordUsage(newBilling(), newUsage(), 'page'), 'translation');
    expect(u).toMatchObject({ freePages: 1, freeTranslations: 1, pages: 0 });
  });

  it('stores notes only on Plus and Pro', () => {
    expect(storesNotes(newBilling())).toBe(false);
    expect(storesNotes(paid('starter'))).toBe(false);
    expect(storesNotes(paid('plus'))).toBe(true);
    expect(storesNotes(paid('pro'))).toBe(true);
  });

  it('summarises the account for the UI', () => {
    expect(summary(paid('plus'), { ...newUsage(), period: 1000, pages: 37 }, ENV)).toMatchObject({
      plan: 'plus', pagesUsed: 37, pagesLimit: 150, storesNotes: true, retentionDays: 30,
      hasSubscription: true, billingReady: true, periodEnd: 2_000_000,
    });
    expect(summary(newBilling(), newUsage(), {}).billingReady).toBe(false);
  });
});

describe('Stripe subscription sync', () => {
  const stripeSub = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_p' }, current_period_start: 1000, current_period_end: 2000 }] },
    ...over,
  });

  it('maps prices to plans', () => {
    expect(planFromPrice('price_x', ENV)).toBe('pro');
    expect(planFromPrice('price_unknown', ENV)).toBeNull();
    expect(planFromPrice(undefined, ENV)).toBeNull();
  });

  it('reads period dates from items or the top level', () => {
    expect(parseSubscription(stripeSub(), ENV)).toMatchObject({ plan: 'plus', periodStart: 1000, periodEnd: 2000 });
    expect(parseSubscription(stripeSub({ current_period_start: 5, current_period_end: 6 }), ENV)).toMatchObject({ periodStart: 5 });
  });

  it('starts a 30-day storage grace period on downgrade or cancellation', () => {
    const pro = paid('pro');
    const toStarter = applySubscription(pro, { ...parseSubscription(stripeSub(), ENV), plan: 'starter' }, NOW);
    expect(Date.parse(toStarter.storageGraceUntil!)).toBe(NOW + 30 * DAY);
    const canceled = applySubscription(paid('plus'), parseSubscription(stripeSub({ status: 'canceled' }), ENV), NOW);
    expect(canceled.storageGraceUntil).toBeDefined();
    const upgrade = applySubscription(paid('plus'), { ...parseSubscription(stripeSub(), ENV), plan: 'pro' }, NOW);
    expect(upgrade.storageGraceUntil).toBeUndefined();
  });

  it('ignores stale events for an old subscription', () => {
    const current = paid('pro', { subscriptionId: 'sub_new' });
    expect(shouldApply(current, parseSubscription(stripeSub({ id: 'sub_old', status: 'canceled' }), ENV))).toBe(false);
    expect(shouldApply(current, parseSubscription(stripeSub({ id: 'sub_new', status: 'canceled' }), ENV))).toBe(true);
  });
});

describe('retention', () => {
  it('keeps Pro forever, Plus 30 days, nothing otherwise', () => {
    expect(retentionCutoff(paid('pro'), NOW)).toBeNull();
    expect(retentionCutoff(paid('plus'), NOW)).toBe(NOW - 30 * DAY);
    expect(retentionCutoff(paid('starter'), NOW)).toBe(NOW);
    expect(retentionCutoff(newBilling(), NOW)).toBe(NOW);
  });

  it('keeps everything during the grace period', () => {
    const graced = paid('pro', { status: 'canceled', storageGraceUntil: new Date(NOW + DAY).toISOString() });
    expect(retentionCutoff(graced, NOW)).toBeNull();
    expect(retentionCutoff(graced, NOW + 2 * DAY)).toBe(NOW + 2 * DAY);
  });
});
