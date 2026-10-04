# The panel

The panel is the plugin's visual surface: a sortable table of every configured
`(provider, model)` route, on the bundle's own page in the Plugins section,
between its description and its rows. This file is the behaviour behind that
table — the columns, the status column, the selection rule, the archive and the
saved state. `README.md` says where the panel is and what the columns mean.

## How it is registered

It is registered in the `plugins.bundle.config` slot that page declares, keyed
by the bundle's package name, so the page draws the title, the icon and the
crumb and the entry contributes the table alone.
`@deepseek-ai/dsh-client-ui-plugin-manager` is listed in `dsh.client.inject`
in `package.json`, so that page's browser half arrives first, and
`ctx.slots.inject('plugins.bundle.config', …)` waits for the page to declare the
slot rather than racing its boot. The page renders the entry only while the
bundle is on, so switching the bundle off takes the table with it. The Plugins
page keeps its navigation in the shell rather than the address bar, so the panel
has no route of its own.

The panel lives on the bundle page rather than in the Settings dialog because
the dialog is a narrow overlay, and a table of `white-space: nowrap` numbers had
no width to stand in.

> The client half is registered when the page boots: after the plugin is first
> installed or its `dsh.client` manifest changes — the `inject` list included —
> do a full browser reload (not a soft HMR reload) to pick up the panel.

## The table

The table is bounded and scrolls both ways inside its wrapper, under a header
pinned to the top and a name column pinned to the left: at twenty-three `nowrap`
columns a row's identity is the first thing to leave the screen, and a table of
numbers that no longer says whose numbers they are is not one to sort.

A row is one model, or one provider in the provider view. Every column heading
is an interactive sort control (`aria-sort`, focus ring, keyboard accessible,
▲/▼ indicator): click any heading to order the table by that figure, and click
it again to reverse the direction. Unmeasured rows stay at the bottom in **both**
directions, in the order every other missing figure uses.

Sorting lives entirely in the headings, so the toolbar holds only the filter,
the probe buttons and the two view toggles, each group under its own caption.

**The status column stands second**, beside the name it belongs to: it is the
one cell a reader acts on, the one column that is always shown, and the one
heading that orders by a verdict rather than by a figure. **The rating column
stands third**, next to the status it pairs with: those two are the whole answer
to "which of these should I use", and every other figure in the row is the
evidence behind them.

By default the table is seven columns wide — name, status, rating, steps,
median response time, median end-to-end throughput (`tok/s e2e med`, including
the first-token wait) and errors per 100 steps (`ош./100`). Streaming
throughput, the absolute error counts and the rest of the sixteen remaining
columns stay one click away under «все метрики». Errors per 100 steps normalize
activity, not task difficulty or blame, and neither they nor the rating measure
answer quality.

**The two tool columns are a group of their own**, at the end of the table and
after a divider: `llm`, `prefill` and `overhead` describe the *inside* of one
step, while `tools/step` and `tool time/step` describe the loop between steps.
Filing them under the same rule would read as one more per-step figure, and the
number under them is a tool's time rather than the model's — which is what their
tooltips say, and what `docs/metrics.md` argues. They open in the directions the
host does (`tools` busiest first, like `steps`; `tool time/step` least first,
like `overhead`), because a click that opened the opposite way from every other
heading is what the shared `SORT_DIRS` map exists to prevent.

### The rating cell

The rating is drawn with one decimal, **no bar and no tone**. A bar is a share
of the largest value in its column, and this figure is already 0-100 on its own
scale, so a bar would say "best of five" where the number says something else;
green and red in this panel mean "best and worst value in the table", and a
rating may not be graded by the company it keeps.

The cell's tooltip and its screen-reader sentence are one string — which is how
a `-`, standing for four different reasons, stays readable without a mouse.

### Bars, tone and the legend

Under the three rate medians — response, `tok/s e2e med` and `ош./100` — every
figure carries a hairline bar: its share of the largest value in that column, so
a column can be read down the page without reading the digits. Which columns are
scaled is the `SCALED` map in `client.js`: a cell draws a bar only for a metric
that pass measured, so `шагов` (a sample size, not a figure about the model) and
the two columns whose metric is deliberately absent (`ретраи`, `префилл`) draw
none. `статус` is a column of words and never had one.

Best median response and best median decode are highlighted green, the worst of
the shown rows red — the two ends come out of one ranking, so a row is never
marked both ways, and a model with no measurement («-») is never marked as the
slowest.

Every column heading explains its own figure on hover, and carries the same
sentence as hidden text so it reaches a screen reader too. The legend that
spells all of this out sits folded under the table. Its first half is read
whichever columns are open: the rating's `~` and `*` are defined there, out of
the very two dictionary keys the cell's own tooltip prints, because the rating
is one of the seven compact columns and a glyph the table prints must not be
one the legend defines only behind a button the reader never pressed.

The last answer is kept in the browser, so reopening the panel paints the table
first and refreshes behind it. There is a refresh button; no timer polls once
the numbers are still.

### The Подробнее disclosure

In the expanded set every name cell carries one disclosure: what the score is
made of — version, qualified and effective samples, both exclusion counts,
sessions, the age of the anchor, the three measured inputs and the three
factors — then what the route declares about itself, and a closing caution.

It is a native `<details>` rather than a popover, because this is the
explanation of the one figure in the row that is a verdict and the browser
gives a `<summary>` keyboard access for free. It is drawn only in the expanded
set and only in the model view, since the compact table is one line per row and
a disclosure under every name would spend that line on rows nobody asked about.
The expanded order groups identity and availability, sample size and recency,
response latency and retries, throughput and its measurement coverage, errors
and interruptions, then duration and input diagnostics. Thin dividers mark the
groups without another sticky header.

## Is the model answering now

History answers how a model behaved. It cannot answer whether the provider is up
this minute, which is the question that decides what to run next. That is what
the **статус** column is: one probe per model, run when you ask for it.

A probe is the smallest possible call, sent **through `ctx.llm`** — the same
route, protocol, credentials, adapter and request shape a real request uses, and
no parameter of its own. That last part is not decoration: the probe used to cap
its answer with `maxTokens: 16` and pin it with `temperature: 0`, and the Codex
backend refuses both by name (`400 Unsupported parameter: max_output_tokens`,
`400 Unsupported parameter: temperature`) — the harness sends neither, so all
seven codex models read as broken while the fold held 335 codex steps that
answered. A shape only this plugin sends measures this plugin. That choice is
the feature: a green circle means the harness itself reached the model, not that
some second HTTP client inside this plugin happened to manage it. A raw HTTP
transport exists only for a route `ctx.llm` does not serve at all (a provider
switched off in the configuration), and each stored result names the transport it
used in its own `source` field.

| Circle | Meaning |
|---|---|
| green | the model answered |
| grey | never probed |
| pulsing (accent) | a probe is running for this model right now |
| amber | the provider refused on a limit — the allowance is spent (*лимит исчерпан*) or the account is being throttled (*слишком часто*) |
| solid red | the check failed with nobody to answer it: a timeout, a dropped connection, a provider error. The cell prints the failure's own status when the panel has no word for it — *timeout*, *server*, *http_500*, *transport* |
| filled red square | the row is not configured, and the fix is on this side: *нет доступа* (the key was refused or is missing), *нет маршрута* (no endpoint is declared for the provider), *нет модели* (the provider does not know this model) |

### The circle says whose move it is

A failed check has three very different meanings — the provider did not answer,
the provider refused the account, or the row was never configured — and a single
red word for all of them sends the reader looking for another model in two cases
out of three. So the tone splits by whose fix it is: amber is the account (a
pause or a top-up), a filled square is this side (a key, an endpoint, a model
list), solid red is theirs (wait or route around).

The fill carries the simplest half of that — filled means somebody else has to
answer — and the shape carries the rest, because at eight pixels a fill
difference alone is just a paler dot. A square and not a circle, because corners
are what survive being drawn this small. It is filled, which makes it the
loudest mark in the column — more ink than the circle that means "the provider
did not answer" — and that is the point: a row that cannot be run at all, and
cannot be made to run by waiting, is louder news than a route that may answer
again. These two words are also the rarest, so the column can afford it; the
outlined variant is one line away (drop the fill, keep an inset 1.5px ring) if
the hierarchy ever matters more than the alarm.

### A refusal on a limit is an answer, not a breakdown

A probe that comes back `RATE_LIMIT`, `QUOTA` / `ACCOUNT_QUOTA` or a bare
`HTTP_429` / `HTTP_402` reached the provider, was accepted as a request and was
declined on the account — so the circle is amber. The same goes for a refused
credential (`AUTH`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `NO_KEY`,
`HTTP_401/403`) and for a route or a model that was never configured
(`NO_ROUTE`, `NO_ADAPTER`, `NO_BASE_URL`, `UNSUPPORTED_API`, `UNKNOWN_MODEL`,
`HTTP_404`) — none of those is the model being slow or dead, and the codes are
`dsh-llm`'s own machine-routable failure classes.

One failure of another kind (a timeout, a dropped connection, a 5xx) makes the
row — or the whole provider, in the provider view — down, not merely refused: a
roll-up only wears a refusal's circle when *every* model in it was refused the
same way, and when route and model faults are mixed, the route wins, because a
missing route makes the model question moot.

### The code decides the state; the word needs more than the code

`dsh-llm` folds a spent daily allowance and a momentary throttle into the same
`RATE_LIMIT`, because its quota classifier looks for the wordings it knows and
falls through to the status code for the rest — a free tier answering `429` with
"Daily free limit reached … tokens used … resets at 00:00 UTC" is stored as
`RATE_LIMIT`. And a model that does not exist arrives from several providers as
a plain `INVALID_REQUEST`, with the reason only in the body.

So the panel also reads the provider's own sentence, and only ever to choose
between words: an explicit quota code settles it, wording that says the account
has to be *paid* before it answers again ("Free models are for active keys … the
last top-up on this key was 2026-09-21, which is more than 7 days ago. Top it up
to use free models again", *recharge*, *add credits*, *balance too low*, *the key
expired*) outranks even the retry promise — that one arrives as the same `429` a
throttle does, and a reader told to wait for it is being told to do the only
thing that cannot help. A promise of a retry in seconds ("try again in 1.2s",
`retry-after`, *per minute*) outranks the word "limit" in the same sentence,
spent-allowance wording ("limit reached", "quota exceeded", "tokens used",
"remaining: 0", "insufficient balance") settles the other way, a bare `429` stays
the throttle its code is named after, and "does not exist" / "model_not_found" /
"has no configured model" / "is not available" inside a rejected request is the
one thing that moves a row out of plain red without a code saying so.

Deliberately not "temporarily unavailable": that is a provider having a bad day.
Nothing here routes, retries or decides anything — it is a label, and a miss
costs a word, not behaviour.

### A failure with no word of its own prints its status

Every other word in that column is a claim the panel can stand behind — whose
move it is, what has to change. Red is the one state left, and *недоступна* says
only what every red circle has in common: nobody answered. For a timeout, a
`500` and a dropped socket that is the status restated in Russian, while the
fact that tells those three apart waits one hover away. So a cell that cannot
classify the failure prints what it is: the host's own machine-routable status,
as it arrived, in lower case and without the shouting — `timeout`, `server`,
`http_500`, `transport`. An id and not a sentence, because this panel does not
own that vocabulary and a Russian guess would sit in the cell next to the real
one in the tooltip. A provider roll-up has no status of its own and prints the
list it counted, deduped (`auth · timeout`). With no status at all there is
nothing to print, and the word stands. Only that cell does this: a green circle,
a key, a route and a model all keep the word they are decided by, and so does a
failure that any family claimed — a status printed over a word the panel had
would be a downgrade, not a fallback.

### A failure is dated, and history can outrank it

`виден` is when the model last answered in the recorded history; a probe result
carries its own `checkedAt`. When the history time is *later* than the check,
the failure is older than the evidence and the circle is green — marked *по
истории* so the reader knows the model was not proved live just now, it was
proved live at some other time. That holds for a limit too: a model that
answered after a 429 is throttled no longer, and a model that answered after a
refused key does not have a key problem now. A failure with no later evidence
keeps its own mark — amber, filled red or a red square — which is the half of
that rule that keeps a dead model from being painted alive.

### The status column is a sort control too

Clicking its heading orders the rows by the verdict, in the same hierarchy the
column draws: the filled square first — a row that cannot be run at all, and
cannot be made to run by waiting — then a provider that did not answer, then an
account out of allowance, then the models that are fine. At the very bottom sit
the rows nobody has checked, and that is the rule worth stating: a row with no
probe has no rank at all, so an absence is held at the bottom in **both**
directions instead of being promoted to "worst". A second click reverses the
order, so "available first" is one click away, and a failure the history has
overtaken sorts with the available rows — that is the circle it is drawn as.

It is the one order the fold cannot read off the session log, because a probe
result lives in `liveness.json` and not in the log: the route reads that store
once per request and hands the rank to the aggregate (`lib/status.js`), which
never sees a probe and never guesses one. The classification runs **once, on the
host**, and travels with every result as its `state`, so the circle a reader
looks at and the order the rows are in cannot be two verdicts about one model —
the one failure this control must not have. Rows sharing a state are ordered by
steps and then by name, because every available model shares a rank and a whole
green column would otherwise come out in whatever order the fold happened to
build it in. A caller with no probe store — the agent's tool, whose five orders
do not include this one — degrades to busiest-first rather than to an arbitrary
order.

The evidence — last request, check time and latency, the failure's code and
message — is printed under the circle in the «все метрики» column set. In the
short one the status cell is the circle and its word alone, and the same
sentence moves into the cell's tooltip; the button's accessible name carries it
either way, so nothing is lost without a mouse.

### Ways to run one

| Where | What it probes |
|---|---|
| the circle in a row | that one model |
| **Проверить все** | every configured model, re-probing even a fresh answer |
| **Проверить выбранные** | the models ticked in the «Модели» tree, re-probing even a fresh answer |
| a provider row in the provider view | that provider's models |

The two buttons name their *scope* and each says what it costs in its own
tooltip, because the difference between them is one real request per model.
The scope of the second button is the reader's own selection, resolved over the
catalog the host sent — the same resolution the tree's checkboxes are drawn
from, so the button and the marks cannot disagree — and it is disabled while
nothing is ticked. It travels as the pairs themselves rather than as a rule
document, because a check is a question about models that exist: the host probes
a named pair whether or not the catalog still lists it, and answers `NO_ROUTE`
rather than dropping it, which would look like a green row.
`POST /api/model-scorecard/liveness/check` takes `pairs: [{ provider, model }]`
for that, capped at 1024 pairs, and keeps `provider` / `model` / `all` for the
agent's own tool.

A sweep is not one HTTP request. The host answers `POST` immediately, keeps
probing in the background at four at a time, and the panel follows `pending`
down to zero over the ordinary `GET` — so a check over a hundred models never
becomes a request the browser gives up on. Results are written to
`liveness.json` next to the fold snapshot and survive a restart. The five-minute
freshness window still governs a *plain* catalog click — the agent's
`model_liveness()` with no arguments, which is why its `staleOnly` parameter is
documented as naming what a plain call already does — but no panel button
depends on it any more.

### A probe gets the patience its route has

The budget is resolved per model: the provider profile's own `timeoutMs` if it
declares one, else its `streamIdleTimeoutMs` — the gap the host tolerates
between chunks — and only a route that declares neither falls back to the host's
own default, five minutes of silence before a stream is abandoned.

A flat 15 s for every route was a deadline the host does not have, and it is
wrong in the one direction that matters: a slow free tier answers in 20-200 s, so
every model on NVIDIA's was recorded as a timeout with the provider perfectly
reachable. What the profile declares is what the probe waits, in both
directions: a route that sets a short deadline of its own is judged by that, and
a route that takes two minutes to first token is not called dead while it is
still thinking.

Nothing here probes on a timer, and the plugin still registers nothing on the
request or stream path: a probe happens because someone asked for one.

## Choosing the models the table is about

The panel's table is about the models the reader selected, and the selection is
a **rule**, not a list of pairs. The difference shows the morning after: under
"all of this provider" a model the configuration gained overnight appears in the
next answer, while a list of names captured yesterday would not name it and would
leave it out of a provider the reader had marked as complete. What the panel
sends to the host is the rule document, and what the host does with it is
resolve it against the catalog only the host can see in full.

A rule has two scopes, `live` and `archive`, and each scope three levels:

| Level | What it says |
|---|---|
| `base` | `measured` (every model with history), `all`, or `none` |
| `providers[name]` | `all`, `measured` or `none` for one provider |
| `pairs["provider\u0000model"]` | `on` or `off` for one model — the exception that outranks both |

Precedence is exactly that order, top to bottom: an explicit pair first, then the
provider's rule, then the scope's base. A first open uses
`{ live: { base: 'measured' }, archive: { base: 'none' } }` — every model that has
history and no retired one, which is the set the table showed before a selection
existed, so nothing changes for a reader who never opens the tree.

`providers[name]: "measured"` says *everything of this provider that the history
has run*, and it is a rule rather than the list of the pairs that happen to be
measured for the same reason the rest of the document is: a model the provider
gains and that is run for the first time joins it by itself. A provider whose
every model has been run resolves it to `all`, so on such a provider it is the
same set twice and the tree says so with a `data-state="measured"` and a tooltip
rather than with a difference the reader cannot see.

**A provider row is one decision, over both scopes when it spans both.** The tree
draws one row per provider with one count — `1 из 3 моделей`, counted by the host
over the whole group — and the click writes the same rule into every scope the
group's models belong to. A provider that kept one model and retired another
therefore gets the rule in `live` *and* in `archive`: writing it into one of them
changed fewer rows than the checkbox promised, left the other half on whatever its
own scope said, and started the next click's cycle from a rule the reader had not
just set. A model's own checkbox resolves its scope from the model and not from
the group, so ticking a live model of such a provider writes its exception where
that model actually lives. While the archive is off the catalog holds no archived
model at all, so a group a reader can see is a live group and the click touches
`live` alone.

Two scopes are one statement about two kinds of item: a model outside the
configuration is not a model inside it, and a reader's marks about each are kept
apart. While the archive is off its scope is stored and not applied, so switching
the archive on brings the marks back instead of resetting them — and switching it
on marks nothing by itself, because a scope nobody could see is not a scope a
switch may edit.

### The tree

The tree is one compact line above the table — `Модели 3 из 5` — and the tree
behind a disclosure: a search box, **Выбрать все** and **Снять все**, then one row
per provider with its own checkbox and `N из M моделей` beside it, and its models
indented under it, each labelled with its full id. Altogether the control has to
answer four questions:

- **What is selected now.** The count in the line, and the count beside each
  provider row. A group whose models are partly selected is a real `indeterminate`
  control *and* an `aria-checked="mixed"` *and* a number — the state is never
  carried by colour alone, and a reader who cannot see a dash sees the number.
- **What a click on a group means.** One click, three steps, and it is a cycle
  rather than a descent. A group that is not full goes to *all* — a click has to
  be able to finish what the reader started, and "all except the ones I excluded"
  is not a state a parent checkbox can offer. A full group goes to *none*, which
  is the ordinary meaning of clicking a ticked box. And a group the reader has
  just emptied comes back as *only the models that have history*, which is the
  step a plain "not all → all" cycle cannot reach: "nothing selected" is both "not
  all selected" and "cleared", and only the rule says which of the two the reader
  last asked for. From there the first step takes over again, so a provider whose
  models are half measured walks *partial → all → none → measured-only → all* and
  stops being ambiguous. A click on a group writes a rule about the provider, not
  a list of its models, so a model it gains later follows it — including under the
  measured rule, which is why the third step is one word in the document rather
  than a snapshot of the pairs that were measured today.
- **What a click on one model means.** An exception, written only where the
  reader's wish differs from what the rules already say about that pair.
  Unticking one model under "all of codex" stores one `off` exception; unticking
  it under "nothing selected" stores nothing at all, because the entry would say
  what the rules already say. Returning the tick removes the exception rather
  than writing the opposite one, which is what keeps a saved policy readable.
- **What the mass buttons act on.** Every item available under the current
  archive state — and the search does not narrow that: the search hides rows to
  find a name in, and a group action that silently acted on the visible subset
  would select a set the reader cannot see. Searching changes no mark.

**An empty selection is a state of its own.** The table says «Модели не выбраны»
and offers the way back — «Вернуть выбор по умолчанию», which restores the rule a
first open would have used. Clearing marks is «Снять все», and a button that says
"back to the default" means the default. The reset is visible whenever the rules
are not the default and inert while they are, and it does not turn the archive
off: the archive is a scope switch with its own visible control, not one of the
marks.

**A provider row is an aggregate of steps, not an average of medians.** The
selection is applied to the **raw measurements** — the folded steps, the error
records and the retry records — *before* anything is aggregated. That is not an
implementation detail; it is what a provider row means. An aggregate buckets what
it is handed, so a selection that filtered ready model rows and then averaged
them would compute a provider figure that is an average of medians: a model with
one fast step would weigh as much as a model with a thousand, and the row would
describe a distribution nothing ever measured.

The fixture in `tools/verify-selection.mjs` is built so the two answers cannot be
confused. One provider, two models: `one` has four steps around 100 ms, `two` has
two around 900 ms. Selecting `two` alone gives a provider row of **2 steps and a
905 ms median** — its own measurements, the same numbers its model row shows.
Averaging the two ready rows would have said **504 ms over two models**, a figure
belonging to neither model and to no run of steps.

The same rule decides what a *retry* counts as. A retry record folded from a step
that never produced an answer carries the provider and no model of its own,
because the fold refuses to guess a model across providers: it lands on the
provider row, where the attribution is exact. Under a selection it follows its
provider — it is a measurement of a provider whose models the reader is looking
at — and it is dropped when none of that provider's models is selected, exactly
as it is when no selection is on.

**The provider view does not drop the selection.** A provider row is a roll-up of
the models the reader chose, and it says so: `1 из 2 моделей` beside the provider.
That matters because the aggregate is computed from the selected raw
measurements, so a provider whose slowest model was left out reads faster than
the provider, honestly and visibly.

A switch to another selection is the same kind of question as a switch to another
sort, and it has the same contract: it never takes the table off the screen, the
footer adds what the selection left of the history (the totals beside it are the
whole history by design), and the notice about a stale answer names the selection
as well as the sort, so a table of every measured model is not read as a table of
the selected ones.

### Paging

The panel asks for 200 rows, the host answers with `truncated: true` when the
selection has more, and the panel prints how many rows were shown of how many
and offers **Показать все** — which raises the page to the host's ceiling of
2000. A truncated table read as the whole selection is the one thing a table that
lists what the reader chose must not do, so the notice is not optional and the
limit is never silently applied.

«Показать все» buys the whole selection from the host — 2000 rows, 183 KB of JSON
— and the panel still puts one page of it on the screen, with a line under the
table saying how many of how many are drawn and a control that appends the next
page to the same table. The two bounds are different on purpose: the payload's is
the host's (how much can be sent), the panel's is about what a browser should be
asked to lay out. Measured in this tree, a row of the expanded set is 21 cells
and ~55 element nodes, so 200 rows are ~11 200 nodes and take 59 ms to build
while 2000 are ~110 200 and 302 ms before the browser has styled anything, on
top of ~220 ms of layout and ~107 ms of paint for a table of that shape in
Chromium.

`content-visibility` was measured as the alternative and is not one: on rows it
buys ~2 % of the layout and ~9 % of the paint, on cells it collapses every row to
its intrinsic height (the table's scrollHeight goes 61 421 → 29 031, so the
scrollbar lies), and on the body it does nothing, because the body always
intersects the viewport. Nothing is virtualised, so every drawn row is a real
row: the pinned first column, the keyboard, the screen-reader associations and
the browser's own find-in-page all keep working, and the notice is a
`role="status"` line rather than a silently shorter table.

## Models outside the current configuration

A model the harness no longer serves is still in the history, and a table that
listed it beside the live ones would be recommending something nobody can run.
Every row is therefore graded against the **current configuration** — the catalog
of `(provider, model)` pairs the live `ctx.llm` serves, union the provider routes
the configuration files declare — and a row the configuration does not know is
**archived**: hidden by default, listed on request.

`archived: true` on the tool, `?archived=1` on the route, `"archived": true` on the
panel's own route, and the **archive** checkbox inside the panel's model tree bring
those rows back. A row that is in the archive wears the word `архив` / `archive`
in the name column, so a table with the filter on says which of its rows are
which; the filter chip and the footer count what the archive holds, and the
empty state names it when the archive is why the table is empty.

That count is over the **whole history**, and not over the rows the selection
kept. It is the number that tells a reader what switching the archive on would
show, and the selection's first-open policy is `live: measured, archive: none` —
a count taken off the selected rows therefore reads zero on a first open and keeps
reading zero with the archive switched on and its models sitting in the tree
unticked. The provider filter still narrows it, because that is a question about
the history; the selection is a question about the table, and `archive.shown` is
the half that follows the table.

In the provider view a row is a provider, so it is graded as one: archived while
the configuration serves no model of it at all. One configured model is all a row
of provider totals needs to be reachable.

The grade is made only when it can be made honestly. A catalog whose live half
did not answer (`listProviders` threw, or there is no `ctx.llm` at all) is not a
configuration that serves nothing — it is one this process cannot see — so the
route sends `archive: null`, and the panel offers no control, marks no row and
hides nothing. Measured on this machine, that distinction is the whole table: the
configuration files declare 113 pairs over 10 providers, while the live `ctx.llm`
additionally serves `deepseek-official`, `codex`, `limitdeckai`, `anxb`,
`dsh-provider-qoder` and `local-uns`. Graded by the files alone, 28 of 64 model
rows and 15932 of 26600 steps — 60% of the history — would be archived, among
them `deepseek-official/deepseek-flash` (10617 steps), which is this harness's
own default model and is served by `dsh-llm-deepseek` without any provider block
listing it. With the live catalog, 4 rows and 10 steps are.

The panel's **tree catalog** is graded by the same rule, because it is the list
of what can be selected. A provider the configuration serves no model of has
nothing but archived rows, so with the archive off its group could only ever
answer an empty table; it leaves the tree with the rows that arm it, and the
archive checkbox brings it back beside them. Measured on this machine against a
catalog of 142 pairs over 16 providers, one name of the history's 16 is in that
position: `wormsoft` (1 model row, 3 steps, against those same 4 rows and 10
steps), which the tree offers again — 16 names without the archive, 17 with it.

`local-uns` is the case that stays although two of its three rows are retired:
`Ornith-1.5-9B-MLX-8bit` is configured, so the provider is reachable, and a
provider the history has never seen keeps its place for the same reason — the
configuration serves it (`ollama`, 22 configured pairs, no history at all).
Nothing was graded under `archive: null`, so nothing left the list either.

Like the selection, the archive is applied over the whole selected set and before
the limit, so a page of fifteen rows is fifteen rows the reader can use; `shown`
in the payload counts the rows the grade kept, and `archive` says what that cost
(`{ rows, steps, shown }`).

## Models the configuration serves and the history has not seen

The archive is one half of a statement about one row; this is the other half. A
model the live catalog serves and no session has ever run has no history to fold,
and a fold cannot invent a row it has no sample for — so it used to be in no table
at all: not in the history, not in the archive, and therefore invisible on exactly
the question the status column exists to answer.

It is now a row: `steps: 0` (a measurement — no step was ever recorded for that
pair) with every other figure unmeasured (`-`), `archived: false` by
construction, and the status circle that makes it testable, because the liveness
join looks a pair up by name and does not care where its row came from. It wears
**нет статистики** / **no statistics** in the name column, so a table of dashes
says which kind of row it is looking at, and the footer counts them
(`без статистики: 92`) over the filtered set, exactly as it counts the archive.
Three properties of it are deliberate:

- **The rows are sorted, not appended.** Placing them "after the measured ones"
  would be a second order: under `steps` ascending, or under `name`, an unmeasured
  row belongs *between* two measured ones, and a table whose order contradicts its
  own heading is worse than one that leaves rows out. The union is re-sorted with
  the fold's own comparator (`comparatorFor`, exported for this), which already
  knows what a missing figure means: it stays at the bottom in both directions.
- **The status order ranks them too.** A probe's rank is not in the session log,
  and the catalog is what a sweep walks, so these rows are the ones a probe store
  is most likely to know. The route hands the same `statusOf` lookup to the fold
  and to the payload, or the one order a reader uses to ask "what is broken right
  now" would file every row this feature adds at the bottom.
- **A page is asked for that can hold them.** The panel names the route's maximum
  (`limit=200`) and the table scrolls, because the unmeasured rows sort last and
  a 50-row page would hold five of the 92.

`noStats: { rows }` carries the count, and it is `null` — like `archive` — when the
host could not read the live catalog: how many rows a configuration holds that the
history never saw is a claim that needs a configuration. The provider list the
filter draws is extended the same way: a provider whose every model is configured
and unused (`ollama` here: 22 pairs, no history at all) is offered with zero
steps, because a filter that cannot name a provider cannot reach its rows.

Measured on this machine by driving the shipped host half (`apply()` and the real
route handler) against its own snapshot, with the probe store standing in for the
live catalog: the history holds 64 model rows over 16 providers, 19 of them
outside the configuration; the probe store — the catalog past sweeps were given —
names 137 pairs over 16 providers; and the answer is **141 rows, 60 of them with
history and 81 without**, of which 77 carry a probe result (27 `denied`, 37
`down`, 6 `up`, 4 `missing`, 3 `limited`, 4 never checked). It is 183 KB of JSON,
answered in 73 ms. At the old page size the same answer carried **none** of those
81: `limit=50` returned 50 rows, every one with history, because the measured rows
fill the page first — which is exactly what their sort says they should.

The agent's text table is deliberately **not** extended. It is a plain-text table
with a 15-row default limit, and 92 unmeasured rows would push measured ones out
of it without giving the agent a decision it can make from them; the agent's route
to finding out whether such a model works is `model_liveness`, which already walks
the whole configured catalog. The two surfaces disagree about *what is listed*,
never about a figure: every number the tool prints comes from the same fold the
panel's rows do.

## Language and icon

The panel follows the GUI's language. Its copy ships as `ru` and `en`
dictionaries registered under the `dsh-model-scorecard` locale namespace, so the
Settings language switcher (and any language pack) applies to it, including the
panel's own heading and the number and date formats. On a host without the
`locale` client service the panel falls back to its built-in Russian copy. The
bundle page around it is the Plugins page's own chrome, so its title and
description come from `locale/*.json` instead, not from this dictionary.

The plugin's own row in the plugin list gets its name and summary the same way,
but from files rather than from the running client: the Host reads
`locale/<language>.json` (`{ "meta": { "title": …, "description": … } }`) through
the module resolver, which is why `package.json` has to export `./locale/*.json`.
With no dictionary the Host falls back to the package name and its `description`
field, so an English `locale/en.json` is what gives those two fields a human name
at all — a `meta` object in `package.json` is not part of the package manifest and
nothing reads it. Like every other host-side change here, this one appears in the
plugin list only after DSH restarts.

The icon on that row and on the bundle page is the one field of the three that
does *not* live in a locale file: `package.json` declares `"icon": "icon.svg"`, a
path relative to the package root that the Host reads, contains within the package
after `realpath` resolution, caps at 256 KiB and inlines as a data URL — the
manifest field is documented in `@deepseek-ai/dsh-package-manifest`'s
`DshPackageManifest.icon`, and SVG, PNG, JPEG and WebP are all accepted. A package
without it draws the Host's generic glyph instead. `icon.svg` is the panel's own
signature at 36 px: three ascending rounded bars, the figure the table draws a
bar under, so the list row and the table say the same thing. It is listed in
`files` so a packed tarball carries it. Unlike the two locale fields the icon was
picked up without restarting DSH, because the plugin metadata is re-read with the
package.

## Where the panel keeps its question

**The question the panel asks lives in `localStorage`, not in the address.** It
used to be in the address, under five namespaced keys (`msSort`, `msDir`, `msView`,
`msProvider`, `msArchived`), which made a table shareable as a link. The
selection is what ended that: it is a *rule document* — "all of codex except the
mini" — and a rule document in a query string is either truncated or spelled out
in a place the host's page can read. Rather than have one surface remember half
its question in one place and half in another, the whole question moved into the
store: the sort, the direction, the view, the archive and the rules are one
document under one versioned key, `dsh-model-scorecard:prefs:v2.selection`. Every
parameter of the host's page is left exactly as it was found — the panel never
writes the address at all, and a leftover `msSort` in a bookmark is ignored rather
than half-honoured.

The key carries its version because the shape changed: v1 held a flat list of
provider names, which is not a rule and cannot say "everything of this provider
except one model". A v1 store is migrated **once**, explicitly, when it is first
read — its provider names become "all of this provider" rules under the default
base, which is the same set of rows the old filter showed — and the old key is
left where it is. An *empty* v1 list keeps meaning "no filter" and never "nothing
selected": the panel that read it as an empty selection would open blank for
everyone who never touched that control. A store the browser refuses (a locked-down
profile) is not a reason to lose the panel: the selection lives in memory for the
tab, and the panel says so beside the count.

The last answer is kept too, under one key that includes the page: a
whole-selection answer is not a larger answer to a paged question, and a store
that could not tell them apart served one for the other.