/**
 * exit-waterfall — liquidation-preference waterfalls for startup cap tables.
 *
 * Preference stacks (1x/Nx multiples, seniority tiers or pari passu),
 * participating vs non-participating preferred with participation caps,
 * common and options (with strike prices), and the conversion decision: each preferred class takes its preference path or
 * converts to common, whichever pays more, solved to a stable equilibrium.
 *
 * Proceeds are always fully conserved: Σ distributions = proceeds.
 */

export interface PreferredClass {
  name: string;
  /** As-converted common shares held by the class. */
  shares: number;
  /** Total amount invested (the preference base). */
  invested: number;
  /** Liquidation preference multiple. Default 1 (1x). */
  preferenceMultiple?: number;
  /**
   * Seniority tier: 1 pays first, 2 next, … Classes sharing a tier are pari
   * passu (pro-rata by preference amount). Default: all tier 1.
   */
  seniority?: number;
  /** Participating preferred (double dip). Default false. */
  participating?: boolean;
  /**
   * Participation cap as a multiple of `invested` for the class's TOTAL
   * return (preference + participation), e.g. 3 for "capped at 3x".
   * Undefined = uncapped participation.
   */
  participationCap?: number;
}

export interface CommonClass {
  name: string;
  shares: number;
  /**
   * Exercise price per share, for options/warrants. Default 0 (common stock).
   * A class with a strike only participates once the common price per share
   * exceeds it, and receives `shares × (price − strike)` — the standard
   * net-exercise / cash-out treatment, solved exactly (the aggregate exercise
   * price raises the price for everyone, as in a treasury-method cash-out).
   */
  strike?: number;
}

export interface WaterfallInputs {
  /** Total exit proceeds to distribute. */
  proceeds: number;
  preferred: readonly PreferredClass[];
  common: readonly CommonClass[];
}

export interface Distribution {
  name: string;
  kind: "preferred" | "common";
  /** Total paid to the class. */
  amount: number;
  /** Whether the class converted to common (preferred only). */
  converted: boolean;
  /** Paid via the preference. */
  fromPreference: number;
  /** Paid via participation / common sharing. */
  fromParticipation: number;
  /** Return multiple on invested (preferred only; null for common). */
  multiple: number | null;
}

export interface WaterfallResult {
  distributions: Distribution[];
  /**
   * Value of one share of common in this exit (what converted preferred and
   * participating preferred receive per share from the residual; options
   * receive this minus their strike). 0 when the preferences absorb everything.
   */
  pricePerCommonShare: number;
  /** Names of preferred classes that converted. */
  converted: string[];
  totalDistributed: number;
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new RangeError(msg);
}

function validate(inputs: WaterfallInputs): void {
  check(Number.isFinite(inputs.proceeds) && inputs.proceeds >= 0, "proceeds must be ≥ 0");
  const names = new Set<string>();
  let totalShares = 0;
  for (const p of [...inputs.preferred, ...inputs.common]) {
    check(!names.has(p.name), `duplicate class name "${p.name}"`);
    names.add(p.name);
    check(Number.isFinite(p.shares) && p.shares >= 0, `${p.name}: shares must be ≥ 0`);
    totalShares += p.shares;
  }
  check(totalShares > 0, "at least one class must hold shares (otherwise residual proceeds have no owner)");
  for (const c of inputs.common) {
    check(
      c.strike === undefined || (Number.isFinite(c.strike) && c.strike >= 0),
      `${c.name}: strike must be ≥ 0`,
    );
  }
  for (const p of inputs.preferred) {
    check(Number.isFinite(p.invested) && p.invested > 0, `${p.name}: invested must be positive`);
    const mult = p.preferenceMultiple ?? 1;
    check(Number.isFinite(mult) && mult > 0, `${p.name}: preferenceMultiple must be positive`);
    check(
      p.participationCap === undefined || p.participationCap >= 1,
      `${p.name}: participationCap must be ≥ 1 (a multiple of invested)`,
    );
    check(
      p.seniority === undefined || (Number.isInteger(p.seniority) && p.seniority >= 1),
      `${p.name}: seniority must be a positive integer`,
    );
  }
}

interface Payout {
  fromPreference: number;
  fromParticipation: number;
}

interface Participant {
  name: string;
  shares: number;
  /** Per-share threshold below which the participant receives nothing (option strike). */
  strike: number;
  /** Maximum it can receive from the residual (participation cap); Infinity if none. */
  capacity: number;
}

/**
 * Share `amount` among participants at a single common price per share p:
 * participant i receives min(capacity_i, shares_i × max(0, p − strike_i)).
 * The total is continuous, non-decreasing and piecewise linear in p, so p is
 * solved exactly by walking the breakpoints (strikes and cap levels).
 * Returns p (Infinity if every participant is capped below `amount`).
 */
function solveCommonPrice(participants: readonly Participant[], amount: number): number {
  if (amount <= 0) return 0;
  const events: { p: number; dSlope: number }[] = [];
  for (const x of participants) {
    if (x.shares <= 0 || x.capacity <= 0) continue;
    events.push({ p: x.strike, dSlope: x.shares });
    if (Number.isFinite(x.capacity)) events.push({ p: x.strike + x.capacity / x.shares, dSlope: -x.shares });
  }
  events.sort((a, b) => a.p - b.p);
  let p = 0;
  let value = 0;
  let slope = 0;
  for (const e of events) {
    if (slope > 0 && value + slope * (e.p - p) >= amount) return p + (amount - value) / slope;
    value += slope * (e.p - p);
    p = e.p;
    slope += e.dSlope;
  }
  return slope > 0 ? p + (amount - value) / slope : Infinity;
}

interface Distributed {
  payouts: Map<string, Payout>;
  pricePerCommonShare: number;
}

/**
 * Distribute proceeds for a FIXED set of conversion decisions.
 * Returns payouts per class name.
 */
function distribute(inputs: WaterfallInputs, convertedSet: ReadonlySet<string>): Distributed {
  const payouts = new Map<string, Payout>();
  for (const p of inputs.preferred) payouts.set(p.name, { fromPreference: 0, fromParticipation: 0 });
  for (const c of inputs.common) payouts.set(c.name, { fromPreference: 0, fromParticipation: 0 });

  let remaining = inputs.proceeds;

  // 1. Preference by seniority tier (converted classes waive preference).
  const nonConverted = inputs.preferred.filter((p) => !convertedSet.has(p.name));
  const tiers = [...new Set(nonConverted.map((p) => p.seniority ?? 1))].sort((a, b) => a - b);
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const classes = nonConverted.filter((p) => (p.seniority ?? 1) === tier);
    const totalPref = classes.reduce((a, p) => a + p.invested * (p.preferenceMultiple ?? 1), 0);
    const pay = Math.min(remaining, totalPref);
    for (const p of classes) {
      const pref = p.invested * (p.preferenceMultiple ?? 1);
      payouts.get(p.name)!.fromPreference = (pay * pref) / totalPref;
    }
    remaining -= pay;
  }

  // 2. Residual: common (and options above their strike) + converted
  //    preferred + participating non-converted preferred (up to its cap), all
  //    at one common price per share.
  const participants: Participant[] = [];
  for (const c of inputs.common) {
    participants.push({ name: c.name, shares: c.shares, strike: c.strike ?? 0, capacity: Infinity });
  }
  for (const p of inputs.preferred) {
    if (convertedSet.has(p.name)) {
      participants.push({ name: p.name, shares: p.shares, strike: 0, capacity: Infinity });
    } else if (p.participating) {
      const already = payouts.get(p.name)!.fromPreference;
      const capTotal = p.participationCap === undefined ? Infinity : p.participationCap * p.invested;
      participants.push({ name: p.name, shares: p.shares, strike: 0, capacity: Math.max(0, capTotal - already) });
    }
  }

  let price = solveCommonPrice(participants, remaining);
  if (Number.isFinite(price)) {
    for (const x of participants) {
      if (x.shares <= 0) continue;
      payouts.get(x.name)!.fromParticipation = Math.min(x.capacity, x.shares * Math.max(0, price - x.strike));
    }
  } else {
    // Degenerate: every residual participant is a capped participating class
    // (no common, options or converted shares). Pay caps, then share the
    // excess pro-rata by shares so proceeds are conserved.
    let paid = 0;
    let shares = 0;
    for (const x of participants) {
      payouts.get(x.name)!.fromParticipation = x.capacity;
      paid += x.capacity;
      shares += x.shares;
    }
    const excess = remaining - paid;
    for (const x of participants) {
      if (x.shares > 0) payouts.get(x.name)!.fromParticipation += (excess * x.shares) / shares;
    }
    price = 0;
  }

  return { payouts, pricePerCommonShare: price };
}

function totalFor(p: Payout): number {
  return p.fromPreference + p.fromParticipation;
}

/**
 * The conversion decisions: a Nash equilibrium in which no preferred class
 * can strictly gain by switching (converting, or reverting to its
 * preference), holding the others fixed.
 *
 * Solved by best-response dynamics from "nobody converts", scanning classes
 * in ascending order of the per-share value at which converting starts to
 * pay (preference ÷ shares, or cap ÷ shares for capped participating), so the
 * result does not depend on input order. A switch can make an earlier
 * converter want to revert (a conversion lowers the common price), which the
 * dynamics handle. If they ever cycle, falls back to an exhaustive search
 * for the equilibrium with the fewest conversions.
 */
function solveConversions(inputs: WaterfallInputs): Set<string> {
  const eps = 1e-9 * Math.max(1, inputs.proceeds);
  const threshold = (p: PreferredClass): number => {
    if (p.participating && p.participationCap === undefined) return Infinity;
    const base = p.participating ? p.participationCap! : (p.preferenceMultiple ?? 1);
    return (base * p.invested) / p.shares;
  };
  // A class with no shares can never gain by converting.
  const candidates = inputs.preferred
    .map((p, i) => ({ p, i, t: threshold(p) }))
    .filter((x) => x.p.shares > 0)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.p);

  const gain = (state: ReadonlySet<string>, name: string): number => {
    const flipped = new Set(state);
    if (flipped.has(name)) flipped.delete(name);
    else flipped.add(name);
    return (
      totalFor(distribute(inputs, flipped).payouts.get(name)!) -
      totalFor(distribute(inputs, state).payouts.get(name)!)
    );
  };
  const isStable = (state: ReadonlySet<string>) => candidates.every((p) => gain(state, p.name) <= eps);

  let state = new Set<string>();
  const maxSteps = 4 * candidates.length * candidates.length + 16;
  for (let step = 0; step < maxSteps; step++) {
    const mover = candidates.find((p) => gain(state, p.name) > eps);
    if (!mover) return state;
    state = new Set(state);
    if (state.has(mover.name)) state.delete(mover.name);
    else state.add(mover.name);
  }

  check(candidates.length <= 16, "conversion decisions did not reach a stable equilibrium");
  const subsets = Array.from({ length: 1 << candidates.length }, (_, m) => m).sort(
    (a, b) => popcount(a) - popcount(b) || a - b,
  );
  for (const mask of subsets) {
    const trial = new Set(candidates.filter((_, k) => mask & (1 << k)).map((p) => p.name));
    if (isStable(trial)) return trial;
  }
  throw new RangeError("no stable set of conversion decisions exists for these terms");
}

function popcount(n: number): number {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
}

/**
 * Solve the waterfall, including each preferred class's convert-or-preference
 * decision (a stable equilibrium: no class can strictly gain by switching
 * between its preference path and converting to common, holding the other
 * classes' decisions fixed).
 *
 * ```ts
 * exitWaterfall({
 *   proceeds: 15_000_000,
 *   preferred: [{ name: "Series A", shares: 2_000_000, invested: 2_000_000 }],
 *   common: [{ name: "Common", shares: 8_000_000 }],
 * });
 * // Series A converts: 20% of $15M = $3M beats its $2M preference
 * ```
 */
export function exitWaterfall(inputs: WaterfallInputs): WaterfallResult {
  validate(inputs);
  const convertedSet = solveConversions(inputs);

  const { payouts: final, pricePerCommonShare } = distribute(inputs, convertedSet);
  const distributions: Distribution[] = [];
  for (const p of inputs.preferred) {
    const pay = final.get(p.name)!;
    distributions.push({
      name: p.name,
      kind: "preferred",
      amount: totalFor(pay),
      converted: convertedSet.has(p.name),
      fromPreference: pay.fromPreference,
      fromParticipation: pay.fromParticipation,
      multiple: totalFor(pay) / p.invested,
    });
  }
  for (const c of inputs.common) {
    const pay = final.get(c.name)!;
    distributions.push({
      name: c.name,
      kind: "common",
      amount: totalFor(pay),
      converted: false,
      fromPreference: 0,
      fromParticipation: pay.fromParticipation,
      multiple: null,
    });
  }
  const totalDistributed = distributions.reduce((a, d) => a + d.amount, 0);
  return {
    distributions,
    pricePerCommonShare,
    converted: inputs.preferred.filter((p) => convertedSet.has(p.name)).map((p) => p.name),
    totalDistributed,
  };
}
