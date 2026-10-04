# The rating

The rating is the one figure that weighs the others: a single 0-100 number for
one exact `(provider, model)` pair, computed from committed history alone — no
clock, no I/O, no DSH import — and published under a version (`technical-v1`),
so a later revision is a new formula rather than a silent drift of this one.

## The formula

```
S = V50 / (V50 + 100)      generation throughput, half credit at 100 tok/s
L = 1 / (1 + T50 / 5000)   typical response,        half credit at 5 s
P = 1 / (1 + T90 / 15000)  slow response,           half credit at 15 s

score = 100 * S^0.45 * L^0.35 * P^0.20
```

`V50`, `T50` and `T90` are the recency-weighted medians and p90 of the
**streaming** tok/s, the median first token and the p90 first token.

Each factor is a saturating utility in (0, 1], so a route sitting on all three
anchors scores exactly 50 and the product is monotonic: faster delivery with the
rest held fixed can never lower the score. The weights and the anchors are
product choices, not fitted constants — they decide what "good" means here —
and they live in one frozen `RATING_POLICY` that the report quotes rather than
restates, so a change to a weight changes the sentence under the table with it.

## The arithmetic, on this machine's largest row

`deepseek-official/deepseek-flash` has 9946 answered steps across 84 sessions,
of which 9501 qualify (95.5%; 11 retried and 9 interrupted steps are excluded,
and those two counts may overlap — a step can be both). Its weighted medians
are 289.0 tok/s, 1917 ms and a p90 of 2763 ms:

```
S = 289.01 / (289.01 + 100)  = 0.7429
L = 1 / (1 + 1917 / 5000)    = 0.7229
P = 1 / (1 + 2763 / 15000)   = 0.8445

100 * 0.7429^0.45 * 0.7229^0.35 * 0.8445^0.20 = 75.4938   ->  75.5
```

## Two deliberate asymmetries

**Throughput is the streaming rate, not `e2e`.** `e2e` contains the first-token
wait, so scoring it would count that wait twice: once inside `T50` and again
inside a deflated rate.

**`P` is an absolute tail utility rather than a p90/p50 ratio**, because a ratio
rewards slowing an already-fast median — the table would then show a worse route
above a better one.

## The population is narrower than the table's

A retried step measures the retry policy and the network as much as the route;
an interrupted step never delivered a whole answer; a span flushed as one packet
measures log packing. A step that cannot produce a rate does not get to
contribute its latency either, so all three factors describe the same steps — a
latency-only fallback when usage is missing would compare one route's ttft
against another's under a shared score.

That is the whole argument for the eligibility floors (100 ms, 8 tokens, 4
fragments), which live in `lib/eligibility.js` and are shared with the `tps`
column so the two cannot drift apart. On this history the floor drops 425 of
9926 eligible `deepseek-official/deepseek-flash` steps (4.3%) and 402 of 2370
for `openrouter/stealth/space-bunny-alpha` (17%), but 1419 of 1468 for
`limitdeckai2/deepseek-v4-flash` (96.7%). That last row is why a coverage column
of 3.2% is a fact about a route rather than a defect in the table.

## Weight is recency, and there is no cutoff

A measurement 30 days older than the pair's newest usable one counts half, 60
days a quarter, and older keeps decaying instead of disappearing — a fixed
seven-day window was measured first and discards most pairs' evidence entirely.
The anchor is that newest usable sample and never the wall clock, which is what
keeps a score invariant when another model is used, a selection changes, or time
passes with no new evidence.

## What withholds a score, and what marks one

Publication needs 10 qualified *and* 10 effective (Kish) samples. The two are
separate thresholds on purpose: ten samples inside one pair of hours are worth
less than ten spread out, and `nEffective` is what says so.

A published score carries `~` while it is provisional — fewer than 30 effective
samples, or fewer than 3 sessions. Four null reasons are data rather than
sentences (`no_samples`, `no_qualified_samples`, `insufficient_samples`,
`pair_only`), so each surface owns the wording, and the agent's report counts
them in one bounded line (wrapped here to fit the page):

```
rating technical-v1 (0-100): 45% streaming throughput, 35% median first token,
20% slow (p90) first token; weights halve every 30 days from the pair's newest
usable step, retried and interrupted steps are excluded, and a score needs 10
qualified and 10 effective samples. 10 of 10 shown row(s) rated; no score: none.
provisional (5, marked ~: fewer than 30 effective samples or fewer than 3
sessions): tokenator/deepseek-v4.1-flash, clinebot/cline-pass/minimax-m3, ...
```

**The quantiles are published beside a withheld score.** A reader asking why a
route is unrated deserves to see that it was three samples of a fast route
rather than silence: `clinebot/typesafe/jev-router` on this machine is
`insufficient_samples` with 3 qualified samples, while its own weighted medians
read 109.0 tok/s and 1993 ms.

## `~` and `*`

| mark | means | effect on the number |
|---|---|---|
| `~` | provisional: fewer than 30 effective samples, or fewer than 3 sessions | none |
| `*` | the newest usable measurement is older than 30 days | none |
| `-` | no score: one of four null reasons | n/a |

`~` and `*` lead the number in the cell, never trailing it: the column is read
down the right edge of its digits, and a mark printed after the figure would
move that edge on the marked rows alone.

A score older than 30 days is a **caveat, never a re-reading**. Nothing is
recomputed from the age, no bar is drawn against it, and no tone is applied: the
number a reader compares is the number that was computed, and its age is a
sentence about the evidence. Moving the display clock cannot change a score.

## Measured

Over 183 session logs, of which 174 carry a timed step: 18 637 timed steps, 37
model rows over 13 providers. A cold fold and aggregate of the whole corpus
takes 87 ms (median of five fresh processes; 78 ms for the same measurement
before the rating existed). The rating itself is 6.7 ms of that, measured alone
over the same 18 637 samples in 37 pairs; the rest is the fold's eligibility
pass and the panel payload carrying the new object (45.0 KB → 65.2 KB of JSON).
25 rows carry a score, 10 are withheld for `insufficient_samples` and 2 for
`no_qualified_samples`, and 8 of the 25 are provisional.

| model | rating | steps | qualified / answered | rating sessions | what the cell says |
|---|---|---|---|---|---|
| tokenator/deepseek-v4.1-flash | **~78.0** | 15 | 14 / 15 | 1 | `~` — one session is under the 3-session floor |
| deepseek-official/deepseek-flash | **75.5** | 9946 | 9501 / 9946 | 84 | — |
| openrouter/stealth/space-bunny-alpha | **70.0** | 2371 | 1968 / 2371 | 20 | — |
| limitdeckai2/glm-5.3-flash | **~53.1** | 648 | 21 / 648 (3.2%) | 8 | `~` — 3.2% of its steps qualify; 21.0 effective |
| clinebot/typesafe/jev-router | — | 3 | 3 / 3 | 1 | no score: 3 of 10 qualified samples needed |

Sorted by steps, the table leads with `deepseek-official/deepseek-flash` (9946
answered steps) and `openrouter/stealth/space-bunny-alpha` (2371). Sorted by
rating it leads with a 15-step session, and `limitdeckai2/glm-5.3-flash` falls to
53.1 on 21 qualified steps. That disagreement is the reason the column exists,
and the coverage column is what keeps it honest: of that route's 648 answered
steps, 127 are retried and only 21 clear the span, token and fragment floors —
the remaining 500 streamed too briefly, or too small, to be a rate at all.

## What the rating is not

Not intelligence, not correctness, not answer quality, not price, not context
capacity, not current reachability. Each of those either has its own column or
has no authoritative source in this release, and folding them in would make one
number that means five different things.

A failed liveness probe is deliberately *not* an input. VPN state is the
reader's to control, so a route that cannot be reached right now keeps the
score its history earned, and the status column is where "right now" is
answered.

The disclosure under each row ends with the same caution: measurements depend on
request size, reasoning mode and network, and the absence of retries does not
prove the absence of network delay.

## What does and does not move a score

Adding an unrelated provider or model, changing the selected pairs, filtering by
provider, and moving the display clock all leave it exactly where it was. So
does everything about liveness, retry failures, tool errors, cache hit rate and
observed context.

Adding a newer *eligible* measurement does move it; adding a newer excluded one —
retried, interrupted, or a span below the floors — does not, and neither does a
score's own age. The same pair produces the same figure through a cold fold, a
hydrated snapshot, a selection and a `sinceMs`-scoped report, and that is
asserted rather than assumed (`tools/verify-rating-paths.mjs`).

Two properties can only be tested with a frozen clock, and both are pinned on
the two surfaces rather than asserted once: the panel test mounts `client.js`
with an injected `Date.now()` and requires `61,0` at exactly one half-life and
`61,0 *` one millisecond later, and the report test does the same against the
text report and the panel's cell side by side. Flipping either `>` to `>=` fails
exactly one check and nothing else, which is the evidence that the assertion is
aimed at that comparison and not at the code around it.