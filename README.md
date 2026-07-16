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
  common: [{ name: "Common", shares: 6_500_000 }],
});

r.distributions;   // per-class: amount, converted?, fromPreference, fromParticipation, multiple
r.converted;       // which classes chose to convert
r.totalDistributed // always exactly === proceeds
```

## Semantics

- **Preference**: paid by seniority tier (lower number first); classes in the same tier share shortfalls pro-rata by preference amount. Multiple = `invested × preferenceMultiple`.
- **Participation**: after preferences, common + converted classes + participating preferred share the residual pro-rata by shares. A `participationCap` (multiple of invested, total return) fixes a class at its cap, with the excess redistributed — iterated until stable.
- **Conversion equilibrium**: each preferred class converts iff common treatment pays strictly more than its preference path, holding others fixed; iterated (monotone) to a fixed point. This produces the classic breakpoints — including a capped participating class abandoning its cap to convert at large exits.
- **Conservation**: Σ distributions ≡ proceeds, enforced in tests across the whole range.

## Related

Part of a cap-table math family: [`safe-stack-conversion`](https://github.com/moshejs/safe-stack-conversion) · [`priced-round-math`](https://github.com/moshejs/priced-round-math) · [`vesting-schedule-math`](https://github.com/moshejs/vesting-schedule-math).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
