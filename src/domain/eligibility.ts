import { diffDays, localDateOf, minDate } from './dates';
import type { DatePolicy, Ingredient, Lot } from './types';
import { BLOCKED_STATUSES } from './types';

export type EligibilityState = 'eligible' | 'review' | 'blocked';

export interface Eligibility {
  state: EligibilityState;
  reasons: string[];
  /** Non-blocking notes (approved review, sell-by info, unverified non-perishable date). */
  notes: string[];
  /** Earliest applicable hard cutoff (local date), if any. */
  cutoff: string | null;
  cutoffSource: string | null;
  /** True when the governing cutoff is from a verified source. */
  cutoffVerified: boolean;
  /** Days from planned date to the cutoff or quality date, whichever is sooner. */
  daysToUrgency: number | null;
  atRisk: boolean;
  unknownQuantity: boolean;
  qualityPassed: boolean;
  /** FEFO ordering bucket: 0 = dated (by cutoff), 1 = undated (receipt-age fallback). */
  fefoBucket: 0 | 1;
  receivedDate: string;
}

export const DEFAULT_POLICY: DatePolicy = {
  cutoffInclusive: true,
  useByIsHard: true,
  expirationIsHard: true,
  sellByPassed: 'info',
  requireCutoffForPerishable: true,
  requireVerifiedDatesForPerishable: true,
  alertDays: 2,
  jurisdictionNote:
    'Configure to match your local health code and verified operating procedures. Defaults are conservative and are not a compliance determination.',
};

/** True if the lot is past `cutoff` on `planned` under the inclusive/exclusive policy. */
export function isPastCutoff(planned: string, cutoff: string, inclusive: boolean): boolean {
  return inclusive ? planned > cutoff : planned >= cutoff;
}

export function hardCutoffs(lot: Lot, policy: DatePolicy): { date: string; source: string }[] {
  const out: { date: string; source: string }[] = [];
  if (lot.hardDiscardDate) out.push({ date: lot.hardDiscardDate, source: 'hard discard date' });
  if (lot.operationalDiscardDate) out.push({ date: lot.operationalDiscardDate, source: 'operational discard date' });
  if (lot.useByDate && policy.useByIsHard) out.push({ date: lot.useByDate, source: 'use-by date' });
  if (lot.expirationDate && policy.expirationIsHard) out.push({ date: lot.expirationDate, source: 'expiration date' });
  if (lot.lineage && lot.lineage.inheritedCutoff && !lot.lineage.cutoffRuleVerified) {
    out.push({ date: lot.lineage.inheritedCutoff, source: 'earliest input cutoff (prep lineage)' });
  }
  return out;
}

export function evaluateLot(
  lot: Lot,
  ingredient: Ingredient | undefined,
  plannedDate: string,
  policy: DatePolicy,
  timeZone: string,
): Eligibility {
  const reasons: string[] = [];
  const notes: string[] = [];
  const receivedDate = localDateOf(lot.receivedAt, timeZone);
  const perishable = (ingredient?.perishable ?? true) || lot.form !== 'raw';
  let blocked = false;
  let review = false;

  if (!ingredient) {
    review = true;
    reasons.push('Lot ingredient is not in the catalog');
  }

  if (BLOCKED_STATUSES.includes(lot.status)) {
    blocked = true;
    reasons.push(`Lot status is ${lot.status.replace('_', ' ')}`);
  } else if (lot.status === 'needs_review') {
    review = true;
    reasons.push('Lot is marked needs review');
  }

  const cutoffs = hardCutoffs(lot, policy);
  const cutoff = minDate(cutoffs.map((c) => c.date));
  const cutoffSource = cutoff ? cutoffs.filter((c) => c.date === cutoff).map((c) => c.source).join(', ') : null;
  if (cutoff && isPastCutoff(plannedDate, cutoff, policy.cutoffInclusive)) {
    blocked = true;
    reasons.push(`Past ${cutoffSource} (${cutoff}) for service on ${plannedDate}; preparation cannot extend it`);
  }

  // Soft dates: use-by / expiration when policy treats them as non-hard.
  for (const [d, label, hard] of [
    [lot.useByDate, 'use-by', policy.useByIsHard],
    [lot.expirationDate, 'expiration', policy.expirationIsHard],
  ] as const) {
    if (d && !hard && isPastCutoff(plannedDate, d, policy.cutoffInclusive)) {
      review = true;
      reasons.push(`Past ${label} date ${d}; policy requires manager review`);
    }
  }

  let qualityPassed = false;
  if (lot.qualityDate && isPastCutoff(plannedDate, lot.qualityDate, policy.cutoffInclusive)) {
    qualityPassed = true;
    const approval = lot.qualityReview;
    if (approval && approval.validThrough >= plannedDate) {
      notes.push(
        `Quality date ${lot.qualityDate} passed; manager review by ${approval.approvedBy} accepted through ${approval.validThrough}`,
      );
    } else {
      review = true;
      reasons.push(`Quality (best-by) date ${lot.qualityDate} has passed; needs manager/policy review (not automatically unsafe or safe)`);
    }
  }

  if (lot.sellByDate && isPastCutoff(plannedDate, lot.sellByDate, policy.cutoffInclusive)) {
    if (policy.sellByPassed === 'review') {
      review = true;
      reasons.push(`Sell-by date ${lot.sellByDate} has passed; policy requires review`);
    } else {
      notes.push(`Sell-by date ${lot.sellByDate} passed (retail inventory date; informational under current policy)`);
    }
  }

  if (perishable && !cutoff && policy.requireCutoffForPerishable) {
    review = true;
    reasons.push('Perishable lot has no use-by or discard date recorded; date must be confirmed');
  }
  if (cutoff && lot.dateVerification === 'unverified') {
    if (perishable && policy.requireVerifiedDatesForPerishable) {
      review = true;
      reasons.push('Date on perishable lot is unverified');
    } else {
      notes.push('Date unverified');
    }
  }
  if (lot.form === 'prepared' && lot.lineage && !lot.lineage.cutoffRuleVerified && lot.lineage.inheritedCutoff) {
    notes.push(`Prepared output limited by inputs: earliest input cutoff ${lot.lineage.inheritedCutoff}`);
  }

  const unknownQuantity = lot.quantity === null;
  if (unknownQuantity) {
    review = true;
    reasons.push('Quantity on hand is unknown');
  } else if ((lot.quantity as number) <= 0) {
    blocked = true;
    reasons.push('Lot is depleted');
  }

  const urgencyDate = minDate([cutoff, lot.qualityDate]);
  const daysToUrgency = urgencyDate ? diffDays(plannedDate, urgencyDate) : null;
  const atRisk = !blocked && daysToUrgency !== null && daysToUrgency <= policy.alertDays;

  return {
    state: blocked ? 'blocked' : review ? 'review' : 'eligible',
    reasons,
    notes,
    cutoff,
    cutoffSource,
    cutoffVerified: !!cutoff && lot.dateVerification === 'verified',
    daysToUrgency,
    atRisk,
    unknownQuantity,
    qualityPassed,
    fefoBucket: cutoff ? 0 : 1,
    receivedDate,
  };
}

/** FEFO comparator: dated lots by cutoff ascending, then undated lots by receipt age (oldest first). */
export function fefoCompare(a: { lot: Lot; elig: Eligibility }, b: { lot: Lot; elig: Eligibility }): number {
  if (a.elig.fefoBucket !== b.elig.fefoBucket) return a.elig.fefoBucket - b.elig.fefoBucket;
  if (a.elig.fefoBucket === 0 && a.elig.cutoff !== b.elig.cutoff) return (a.elig.cutoff as string) < (b.elig.cutoff as string) ? -1 : 1;
  if (a.lot.receivedAt !== b.lot.receivedAt) return a.lot.receivedAt < b.lot.receivedAt ? -1 : 1;
  return a.lot.id < b.lot.id ? -1 : a.lot.id > b.lot.id ? 1 : 0;
}

export function poolsFor(workspace: 'food' | 'bar'): ('food' | 'bar' | 'shared')[] {
  return workspace === 'food' ? ['food', 'shared'] : ['bar', 'shared'];
}
