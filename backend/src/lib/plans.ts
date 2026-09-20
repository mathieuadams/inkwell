/** Plans, quotas and retention. Pure functions only (no AWS or Stripe calls) so they are easy to test. */

export type Plan = 'free' | 'starter' | 'plus' | 'pro';
export type PaidPlan = Exclude<Plan, 'free'>;
export const PAID_PLANS: PaidPlan[] = ['starter', 'plus', 'pro'];

export const PAGE_LIMITS: Record<PaidPlan, number> = { starter: 20, plus: 150, pro: 500 };
/** Days notes are kept. 0 = never stored, null = kept while subscribed. */
export const RETENTION_DAYS: Record<Plan, number | null> = { free: 0, starter: 0, plus: 30, pro: null };
/** Translations allowed per page of quota, to cap abuse of the translate endpoint. */
export const TRANSLATIONS_PER_PAGE = 5;
/** After a downgrade or cancellation, stored notes are kept this long before cleanup applies the new plan. */
export const GRACE_DAYS = 30;

const DAY = 86_400_000;
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export interface Billing {
  plan: Plan;
  status: string;
  customerId?: string;
  subscriptionId?: string;
  periodStart?: number; // unix seconds
  periodEnd?: number; // unix seconds
  cancelAtPeriodEnd?: boolean;
  storageGraceUntil?: string;
  updatedAt?: string;
}

export interface Usage {
  freePages: number;
  freeTranslations: number;
  period?: number; // Billing.periodStart the counters below belong to
  pages: number;
  translations: number;
}

export interface SubscriptionState {
  id: string;
  status: string;
  plan: PaidPlan | null;
  customerId?: string;
  periodStart?: number;
  periodEnd?: number;
  cancelAtPeriodEnd: boolean;
}

type Env = Record<string, string | undefined>;

export const newBilling = (): Billing => ({ plan: 'free', status: 'none' });
export const newUsage = (): Usage => ({ freePages: 0, freeTranslations: 0, pages: 0, translations: 0 });

export const isPaidPlan = (v: unknown): v is PaidPlan => typeof v === 'string' && (PAID_PLANS as string[]).includes(v);
export const isActiveStatus = (status: string | undefined) => ACTIVE_STATUSES.has(status ?? '');
export const productEnvName = (plan: PaidPlan) => `STRIPE_PRODUCT_${plan.toUpperCase()}`;

export function effectivePlan(b: Billing): Plan {
  return b.plan !== 'free' && isActiveStatus(b.status) ? b.plan : 'free';
}

export function freePageAllowance(env: Env = process.env): number {
  const n = Number(env.FREE_PAGES ?? '3');
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

export function limits(b: Billing, u: Usage, env: Env = process.env) {
  const plan = effectivePlan(b);
  if (plan === 'free') {
    const pagesLimit = freePageAllowance(env);
    return {
      plan,
      pagesUsed: u.freePages,
      pagesLimit,
      translationsUsed: u.freeTranslations,
      translationsLimit: pagesLimit * TRANSLATIONS_PER_PAGE,
    };
  }
  const current = u.period !== undefined && u.period === b.periodStart;
  const pagesLimit = PAGE_LIMITS[plan];
  return {
    plan,
    pagesUsed: current ? u.pages : 0,
    pagesLimit,
    translationsUsed: current ? u.translations : 0,
    translationsLimit: pagesLimit * TRANSLATIONS_PER_PAGE,
  };
}

/** A message for the user when the action is over quota, otherwise null. */
export function checkAllowance(b: Billing, u: Usage, kind: 'page' | 'translation', env: Env = process.env): string | null {
  const l = limits(b, u, env);
  if (kind === 'page' && l.pagesUsed >= l.pagesLimit) {
    if (l.plan !== 'free') return `You've used all ${l.pagesLimit} pages on your plan this month. Upgrade for more pages.`;
    return l.pagesLimit > 0
      ? `You've used your ${l.pagesLimit} free pages. Choose a plan to keep going.`
      : 'Choose a plan to start converting notes.';
  }
  if (kind === 'translation' && l.translationsUsed >= l.translationsLimit) {
    return l.plan === 'free'
      ? 'Choose a plan to keep translating.'
      : "You've reached this month's translation limit. Upgrade for more.";
  }
  return null;
}

export function recordUsage(b: Billing, u: Usage, kind: 'page' | 'translation'): Usage {
  const next = { ...u };
  if (effectivePlan(b) === 'free') {
    if (kind === 'page') next.freePages += 1;
    else next.freeTranslations += 1;
    return next;
  }
  if (next.period === undefined || next.period !== b.periodStart) {
    next.period = b.periodStart;
    next.pages = 0;
    next.translations = 0;
  }
  if (kind === 'page') next.pages += 1;
  else next.translations += 1;
  return next;
}

export const storesNotes = (b: Billing) => RETENTION_DAYS[effectivePlan(b)] !== 0;

export function summary(b: Billing, u: Usage, env: Env = process.env) {
  const l = limits(b, u, env);
  return {
    plan: l.plan,
    status: b.status,
    pagesUsed: l.pagesUsed,
    pagesLimit: l.pagesLimit,
    periodEnd: b.periodEnd ? b.periodEnd * 1000 : null,
    cancelAtPeriodEnd: Boolean(b.cancelAtPeriodEnd),
    storesNotes: storesNotes(b),
    retentionDays: RETENTION_DAYS[l.plan],
    hasSubscription: Boolean(b.subscriptionId) && isActiveStatus(b.status),
    billingReady: PAID_PLANS.every((p) => Boolean(env[productEnvName(p)])),
  };
}

export function planFromProduct(productId: string | undefined, env: Env = process.env): PaidPlan | null {
  if (!productId) return null;
  return PAID_PLANS.find((p) => env[productEnvName(p)] === productId) ?? null;
}

/** Reads the fields we need from a Stripe subscription object (works across API versions). */
export function parseSubscription(obj: any, env: Env = process.env): SubscriptionState {
  const item = obj?.items?.data?.[0];
  const product = item?.price?.product;
  return {
    id: obj.id,
    status: obj.status,
    plan: planFromProduct(typeof product === 'string' ? product : product?.id, env),
    customerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id,
    periodStart: obj.current_period_start ?? item?.current_period_start,
    periodEnd: obj.current_period_end ?? item?.current_period_end,
    cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
  };
}

/** Ignore stale events for an old subscription when the user already has a newer, active one. */
export function shouldApply(prev: Billing, s: SubscriptionState): boolean {
  return !prev.subscriptionId || prev.subscriptionId === s.id || isActiveStatus(s.status) || !isActiveStatus(prev.status);
}

const storageRank: Record<Plan, number> = { free: 0, starter: 0, plus: 1, pro: 2 };

export function applySubscription(prev: Billing, s: SubscriptionState, now = Date.now()): Billing {
  const next: Billing = {
    ...prev,
    plan: s.plan ?? prev.plan,
    status: s.status,
    customerId: s.customerId ?? prev.customerId,
    subscriptionId: s.id,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    updatedAt: new Date(now).toISOString(),
  };
  if (storageRank[effectivePlan(next)] < storageRank[effectivePlan(prev)]) {
    next.storageGraceUntil = new Date(now + GRACE_DAYS * DAY).toISOString();
  }
  return next;
}

/** Notes and uploads last modified before this time (ms) get deleted. null = keep everything. */
export function retentionCutoff(b: Billing, now = Date.now()): number | null {
  if (b.storageGraceUntil && Date.parse(b.storageGraceUntil) > now) return null;
  const days = RETENTION_DAYS[effectivePlan(b)];
  return days === null ? null : now - days * DAY;
}
