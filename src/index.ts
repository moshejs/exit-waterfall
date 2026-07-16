/**
 * exit-waterfall — liquidation-preference waterfalls for startup cap tables.
 *
 * Preference stacks (1x/Nx multiples, seniority tiers or pari passu),
 * participating vs non-participating preferred with participation caps, and
 * the conversion decision: each preferred class takes its preference path or
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
  for (const p of [...inputs.preferred, ...inputs.common]) {
    check(!names.has(p.name), `duplicate class name "${p.name}"`);
    names.add(p.name);
    check(p.shares >= 0, `${p.name}: shares must be ≥ 0`);
  }
  for (const p of inputs.preferred) {
    check(p.invested > 0, `${p.name}: invested must be positive`);
    check((p.preferenceMultiple ?? 1) > 0, `${p.name}: preferenceMultiple must be positive`);
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

/**
 * Distribute proceeds for a FIXED set of conversion decisions.
 * Returns payouts per class name.
 */
function distribute(
  inputs: WaterfallInputs,
  convertedSet: ReadonlySet<string>,
): Map<string, Payout> {
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

  // 2. Residual: common + converted preferred (full shares) + participating
  //    non-converted preferred, pro-rata by shares, with caps redistributed.
  interface Participant {
    name: string;
    shares: number;
    /** Remaining capacity before a participation cap binds; Infinity if none. */
    capacity: number;
  }
  const participants: Participant[] = [];
  for (const c of inputs.common) {
    if (c.shares > 0) participants.push({ name: c.name, shares: c.shares, capacity: Infinity });
  }
  for (const p of inputs.preferred) {
    if (convertedSet.has(p.name)) {
      if (p.shares > 0) participants.push({ name: p.name, shares: p.shares, capacity: Infinity });
    } else if (p.participating && p.shares > 0) {
      const already = payouts.get(p.name)!.fromPreference;
      const capTotal = p.participationCap === undefined ? Infinity : p.participationCap * p.invested;
      participants.push({ name: p.name, shares: p.shares, capacity: Math.max(0, capTotal - already) });
    }
  }

  // Iteratively distribute, fixing capped participants at their capacity.
  let pool = participants.filter((x) => x.capacity > 0);
  while (remaining > 1e-9 && pool.length > 0) {
    const totalShares = pool.reduce((a, x) => a + x.shares, 0);
    const perShare = remaining / totalShares;
    // find participants whose cap binds at this rate
    const binding = pool.filter((x) => x.shares * perShare > x.capacity);
    if (binding.length === 0) {
      for (const x of pool) payouts.get(x.name)!.fromParticipation += x.shares * perShare;
      remaining = 0;
      break;
    }
    for (const x of binding) {
      payouts.get(x.name)!.fromParticipation += x.capacity;
      remaining -= x.capacity;
      x.capacity = 0;
    }
    pool = pool.filter((x) => x.capacity > 0);
  }
  // If everyone is capped and money remains, it goes to unlimited participants;
  // if none exist (degenerate: only capped participants), pay pro-rata anyway
  // to conserve proceeds.
  if (remaining > 1e-9) {
    const everyone = participants.length ? participants : null;
    if (everyone) {
      const totalShares = everyone.reduce((a, x) => a + x.shares, 0);
      if (totalShares > 0) {
        for (const x of everyone) payouts.get(x.name)!.fromParticipation += (remaining * x.shares) / totalShares;
        remaining = 0;
      }
    }
  }

  return payouts;
}

function totalFor(p: Payout): number {
  return p.fromPreference + p.fromParticipation;
}

/**
 * Solve the waterfall, including each preferred class's convert-or-preference
 * decision (iterated to a stable equilibrium: a class converts when taking
 * common treatment pays strictly more than its preference path, holding the
 * other classes' decisions fixed).
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
  const convertedSet = new Set<string>();

  // Monotone iteration: once a class converts it never unconverts.
  for (let iter = 0; iter < inputs.preferred.length + 1; iter++) {
    const base = distribute(inputs, convertedSet);
    let changed = false;
    for (const p of inputs.preferred) {
      if (convertedSet.has(p.name)) continue;
      const trial = new Set(convertedSet);
      trial.add(p.name);
      const withConversion = distribute(inputs, trial);
      if (totalFor(withConversion.get(p.name)!) > totalFor(base.get(p.name)!) + 1e-9) {
        convertedSet.add(p.name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const final = distribute(inputs, convertedSet);
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
  return { distributions, converted: [...convertedSet], totalDistributed };
}
