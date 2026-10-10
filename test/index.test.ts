import { describe, expect, it } from "vitest";
import { exitWaterfall } from "../src/index.js";
import { CASES } from "./fixtures.js";

const byName = (r: ReturnType<typeof exitWaterfall>, name: string) =>
  r.distributions.find((d) => d.name === name)!;

// Series A: $2M for 20% (2M of 10M shares), 1x non-participating.
const BASE = {
  preferred: [{ name: "A", shares: 2_000_000, invested: 2_000_000 }],
  common: [{ name: "Common", shares: 8_000_000 }],
};

describe("1x non-participating — the conversion breakpoint", () => {
  it("low exit: preference only, common wiped", () => {
    const r = exitWaterfall({ proceeds: 1_500_000, ...BASE });
    expect(byName(r, "A").amount).toBeCloseTo(1_500_000, 6);
    expect(byName(r, "A").converted).toBe(false);
    expect(byName(r, "Common").amount).toBeCloseTo(0, 6);
  });

  it("mid exit: A takes its $2M preference; common gets the rest", () => {
    const r = exitWaterfall({ proceeds: 6_000_000, ...BASE });
    expect(byName(r, "A").amount).toBeCloseTo(2_000_000, 6);
    expect(byName(r, "A").converted).toBe(false);
    expect(byName(r, "Common").amount).toBeCloseTo(4_000_000, 6);
  });

  it("high exit: A converts (20% of $15M = $3M > $2M preference)", () => {
    const r = exitWaterfall({ proceeds: 15_000_000, ...BASE });
    expect(byName(r, "A").converted).toBe(true);
    expect(byName(r, "A").amount).toBeCloseTo(3_000_000, 6);
    expect(byName(r, "Common").amount).toBeCloseTo(12_000_000, 6);
  });

  it("proceeds are always fully conserved", () => {
    for (const proceeds of [0, 500_000, 2_000_000, 9_999_999, 15_000_000, 100_000_000]) {
      const r = exitWaterfall({ proceeds, ...BASE });
      expect(r.totalDistributed).toBeCloseTo(proceeds, 4);
    }
  });
});

describe("participating preferred", () => {
  const PART = {
    preferred: [{ name: "A", shares: 2_000_000, invested: 2_000_000, participating: true }],
    common: [{ name: "Common", shares: 8_000_000 }],
  };

  it("uncapped: preference + pro-rata share of the residual (double dip)", () => {
    const r = exitWaterfall({ proceeds: 10_000_000, ...PART });
    // $2M pref, then 20% of the remaining $8M = $1.6M
    expect(byName(r, "A").amount).toBeCloseTo(3_600_000, 4);
    expect(byName(r, "A").fromPreference).toBeCloseTo(2_000_000, 6);
    expect(byName(r, "A").fromParticipation).toBeCloseTo(1_600_000, 4);
    expect(byName(r, "Common").amount).toBeCloseTo(6_400_000, 4);
  });

  it("2x cap binds at mid exits; excess flows to common", () => {
    const capped = {
      preferred: [
        { name: "A", shares: 2_000_000, invested: 2_000_000, participating: true, participationCap: 2 },
      ],
      common: [{ name: "Common", shares: 8_000_000 }],
    };
    const r = exitWaterfall({ proceeds: 14_000_000, ...capped });
    // uncapped would be 2M + 20%×12M = 4.4M; cap = 2×2M = 4M total
    expect(byName(r, "A").amount).toBeCloseTo(4_000_000, 4);
    expect(byName(r, "A").converted).toBe(false);
    expect(byName(r, "Common").amount).toBeCloseTo(10_000_000, 4);
  });

  it("at large exits a capped participating class CONVERTS instead", () => {
    const capped = {
      preferred: [
        { name: "A", shares: 2_000_000, invested: 2_000_000, participating: true, participationCap: 2 },
      ],
      common: [{ name: "Common", shares: 8_000_000 }],
    };
    const r = exitWaterfall({ proceeds: 30_000_000, ...capped });
    // capped path = $4M; converting = 20% × $30M = $6M → converts
    expect(byName(r, "A").converted).toBe(true);
    expect(byName(r, "A").amount).toBeCloseTo(6_000_000, 4);
  });
});

describe("seniority and pari passu", () => {
  const STACK = {
    preferred: [
      { name: "B", shares: 1_500_000, invested: 3_000_000, seniority: 1 },
      { name: "A", shares: 2_000_000, invested: 2_000_000, seniority: 2 },
    ],
    common: [{ name: "Common", shares: 6_500_000 }],
  };

  it("senior class is made whole before the junior sees a dollar", () => {
    const r = exitWaterfall({ proceeds: 4_000_000, ...STACK });
    expect(byName(r, "B").amount).toBeCloseTo(3_000_000, 6);
    expect(byName(r, "A").amount).toBeCloseTo(1_000_000, 6);
    expect(byName(r, "Common").amount).toBeCloseTo(0, 6);
  });

  it("pari passu shares a shortfall pro-rata by preference amount", () => {
    const pari = {
      preferred: [
        { name: "B", shares: 1_500_000, invested: 3_000_000 },
        { name: "A", shares: 2_000_000, invested: 2_000_000 },
      ],
      common: [{ name: "Common", shares: 6_500_000 }],
    };
    const r = exitWaterfall({ proceeds: 4_000_000, ...pari });
    expect(byName(r, "B").amount).toBeCloseTo(2_400_000, 4); // 3/5 of 4M
    expect(byName(r, "A").amount).toBeCloseTo(1_600_000, 4); // 2/5 of 4M
  });

  it("2x preference multiple doubles the preference base", () => {
    const r = exitWaterfall({
      proceeds: 5_000_000,
      preferred: [{ name: "A", shares: 2_000_000, invested: 2_000_000, preferenceMultiple: 2 }],
      common: [{ name: "Common", shares: 8_000_000 }],
    });
    expect(byName(r, "A").amount).toBeCloseTo(4_000_000, 6);
    expect(byName(r, "Common").amount).toBeCloseTo(1_000_000, 6);
  });
});

describe("multi-class equilibrium", () => {
  it("classes convert independently at their own breakpoints", () => {
    const r = exitWaterfall({
      proceeds: 50_000_000,
      preferred: [
        { name: "B", shares: 1_500_000, invested: 6_000_000, seniority: 1 },
        { name: "A", shares: 2_000_000, invested: 1_000_000, seniority: 2 },
      ],
      common: [{ name: "Common", shares: 6_500_000 }],
    });
    // A (10M shares total): converting nets 20% of residual pools — at $50M A
    // clearly converts (its pref is only $1M); B: 15% of 50M = 7.5M > 6M → converts too
    expect(byName(r, "A").converted).toBe(true);
    expect(byName(r, "B").converted).toBe(true);
    // everyone pro-rata: exact share-weighted split of 50M
    expect(byName(r, "Common").amount).toBeCloseTo((6_500_000 / 10_000_000) * 50_000_000, 2);
    expect(r.totalDistributed).toBeCloseTo(50_000_000, 4);
  });

  it("multiple returns are reported", () => {
    const r = exitWaterfall({ proceeds: 15_000_000, ...BASE });
    expect(byName(r, "A").multiple).toBeCloseTo(1.5, 6);
    expect(byName(r, "Common").multiple).toBeNull();
  });
});

describe("validation", () => {
  it("rejects bad inputs", () => {
    expect(() => exitWaterfall({ proceeds: -1, preferred: [], common: [] })).toThrow(RangeError);
    expect(() =>
      exitWaterfall({
        proceeds: 1,
        preferred: [{ name: "A", shares: 1, invested: 0 }],
        common: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      exitWaterfall({
        proceeds: 1,
        preferred: [{ name: "X", shares: 1, invested: 1 }],
        common: [{ name: "X", shares: 1 }],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("conversion equilibrium is order-independent and stable (regression)", () => {
  // Pari passu, 1x non-participating. A: $1M pref on 1M shares ($1.00/sh),
  // B: $1.5M pref on 1M shares ($1.50/sh), 1M common, $4.2M exit.
  // If both convert, everyone gets $1.4M — but B would then rather take its
  // $1.5M preference. Stable answer: A converts (1.35M > 1M), B does not
  // (1.5M > 1.4M), common gets (4.2M − 1.5M) / 2 = 1.35M.
  // v1.0.0 returned B converted at $1.4M when B was listed first.
  const A = { name: "A", shares: 1_000_000, invested: 1_000_000 };
  const B = { name: "B", shares: 1_000_000, invested: 1_500_000 };
  const common = [{ name: "Common", shares: 1_000_000 }];

  for (const preferred of [[A, B], [B, A]]) {
    it(`order ${preferred.map((p) => p.name).join(",")}`, () => {
      const r = exitWaterfall({ proceeds: 4_200_000, preferred, common });
      expect(r.converted).toEqual(["A"]);
      expect(byName(r, "B").amount).toBeCloseTo(1_500_000, 6);
      expect(byName(r, "A").amount).toBeCloseTo(1_350_000, 6);
      expect(byName(r, "Common").amount).toBeCloseTo(1_350_000, 6);
      expect(r.pricePerCommonShare).toBeCloseTo(1.35, 12);
    });
  }
});

describe("options with a strike price", () => {
  const cap = (proceeds: number) =>
    exitWaterfall({
      proceeds,
      preferred: [],
      common: [
        { name: "Common", shares: 8_000_000 },
        { name: "Options", shares: 2_000_000, strike: 1 },
      ],
    });

  it("out of the money: options get nothing", () => {
    // even if exercised: (5M + 2M strike) / 10M = $0.70 < $1 strike
    const r = cap(5_000_000);
    expect(byName(r, "Options").amount).toBe(0);
    expect(byName(r, "Common").amount).toBeCloseTo(5_000_000, 6);
    expect(r.pricePerCommonShare).toBeCloseTo(0.625, 12);
  });

  it("in the money: net of strike, with the exercise price lifting the common price", () => {
    // (20M + 2M) / 10M = $2.20/sh; options net 2M × 1.20 = 2.4M
    const r = cap(20_000_000);
    expect(r.pricePerCommonShare).toBeCloseTo(2.2, 12);
    expect(byName(r, "Options").amount).toBeCloseTo(2_400_000, 6);
    expect(byName(r, "Common").amount).toBeCloseTo(17_600_000, 6);
    expect(r.totalDistributed).toBeCloseTo(20_000_000, 6);
  });

  it("options feed into the preferred conversion decision", () => {
    // A converts: (12M + 2M) / 10M = $1.40 → A gets 2.8M > 2M preference
    const r = exitWaterfall({
      proceeds: 12_000_000,
      preferred: [{ name: "A", shares: 2_000_000, invested: 2_000_000 }],
      common: [
        { name: "Common", shares: 6_000_000 },
        { name: "Options", shares: 2_000_000, strike: 1 },
      ],
    });
    expect(r.converted).toEqual(["A"]);
    expect(byName(r, "A").amount).toBeCloseTo(2_800_000, 6);
    expect(byName(r, "Options").amount).toBeCloseTo(800_000, 6);
    expect(byName(r, "Common").amount).toBeCloseTo(8_400_000, 6);
  });

  it("rejects a negative strike and a cap table with no shares", () => {
    expect(() =>
      exitWaterfall({ proceeds: 1, preferred: [], common: [{ name: "O", shares: 1, strike: -1 }] }),
    ).toThrow(RangeError);
    expect(() =>
      exitWaterfall({ proceeds: 1, preferred: [{ name: "A", shares: 0, invested: 1 }], common: [] }),
    ).toThrow(/hold shares/);
  });
});

describe("independent reference fixtures (exact rationals, exhaustive equilibrium search)", () => {
  it.each(CASES.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    const r = exitWaterfall(c.inputs);
    const tol = 1e-7 * Math.max(1, c.inputs.proceeds);
    expect([...r.converted].sort()).toEqual(c.converted);
    for (const d of r.distributions) expect(Math.abs(d.amount - c.payouts[d.name]!)).toBeLessThan(tol);
    expect(Math.abs(r.pricePerCommonShare - c.price)).toBeLessThan(1e-9 * Math.max(1, c.price));
    expect(Math.abs(r.totalDistributed - c.inputs.proceeds)).toBeLessThan(tol);
  });
});
