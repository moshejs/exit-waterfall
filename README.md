# exit-waterfall

Startup **exit waterfall** math — liquidation-preference stacks (seniority tiers or pari passu, Nx multiples), **participating vs non-participating** preferred with participation caps, and the **convert-or-not equilibrium**. Zero dependencies.

```
npm install exit-waterfall
```

## Why

"We sold for $30M — who gets what?" is the question every founder, VC, and M&A model answers, and the answer hinges on mechanics that are easy to get wrong: senior preferences pay first; participating preferred double-dips until a cap binds; and every class implicitly chooses the *better* of its preference path or converting to common — a decision that depends on everyone else's decision. Every npm "waterfall" package is an async control-flow library. This one does the actual finance.

```ts
import { exitWaterfall } from "exit-waterfall";

const r = exitWaterfall({
  proceeds: 30_000_000,
  preferred: [
    { name: "Series B", shares: 1_500_000, invested: 6_000_000, seniority: 1 },
    { name: "Series A", shares: 2_000_000, invested: 2_000_000, seniority: 2,
      participating: true, participationCap: 2 },
  ],
  common: [
    { name: "Common", shares: 6_000_000 },
    { name: "Options", shares: 500_000, strike: 0.5 }, // paid net of strike, only when in the money
  ],
});

r.distributions;       // per-class: amount, converted?, fromPreference, fromParticipation, multiple
r.converted;           // which classes chose to convert (input order)
r.pricePerCommonShare; // value of one common share in this exit
r.totalDistributed;    // === proceeds (up to floating-point rounding)
```

## Semantics

- **Preference**: paid by seniority tier (lower number first); classes in the same tier share shortfalls pro-rata by preference amount. Multiple = `invested × preferenceMultiple`.
- **Participation**: after preferences, common + converted classes + participating preferred share the residual at one common price per share. A `participationCap` (multiple of invested, total return including the preference) fixes a class at its cap, with the excess going to everyone else. Solved exactly (no iteration tolerance).
- **Options / warrants**: give a common class a `strike` (exercise price per share). It receives `shares × max(0, pricePerCommonShare − strike)`, i.e. in-the-money options are cashed out net of exercise price and out-of-the-money options get nothing; the aggregate exercise price raises the common price for everyone, exactly as if the options were exercised and the cash added to proceeds.
- **Conversion equilibrium**: the result is a stable (Nash) equilibrium: no preferred class can strictly gain by switching between its preference path and converting to common, holding the others fixed. Found by best-response dynamics starting from "nobody converts", taking classes in ascending order of their per-share conversion threshold, so the answer does not depend on input order. A later conversion lowers the common price and can make an earlier converter revert to its preference; that is handled. When a class is exactly indifferent it does not convert. This produces the classic breakpoints, including a capped participating class abandoning its cap to convert at large exits.
- **Conservation**: Σ distributions = proceeds. Inputs must include at least one class with shares, so residual proceeds always have an owner.
- **Not modeled**: cumulative or accrued dividends, catch-up provisions, escrows/earn-outs, and transaction fees (deduct fees from `proceeds` first).

Verified against an independent exact-rational reference that enumerates every possible set of conversion decisions (6,000 random cap tables with seniority tiers, multiples, capped participation and options; 150 committed as test fixtures).

## Related

Part of a cap-table math family: [`safe-stack-conversion`](https://github.com/moshejs/safe-stack-conversion) · [`priced-round-math`](https://github.com/moshejs/priced-round-math) · [`vesting-schedule-math`](https://github.com/moshejs/vesting-schedule-math).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
