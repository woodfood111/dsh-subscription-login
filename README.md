# dsh-subscription-login

Bring non-DeepSeek AI subscriptions (ChatGPT Codex, Claude, GitHub Copilot, OpenRouter, Kimi Code, xAI SuperGrok/X Premium) into DeepSeek Harness — **one page for all of them**.

It lives in **Settings → Plugins → Subscriptions**. It lists every sign-in your deployment actually registered, walks you through one, and shows you what happened.

## What makes it different from the other subscription plugins

There are five or six of them already, and each hardcodes its own provider. This one hardcodes nothing:

- **The list comes from `ctx.authorization`**, filled by `dsh-llm-pi-ai`, which registers one flow per installed pi-ai provider that ships a login. When pi-ai gains a provider, it appears here with no change to this plugin.
- **It supplies the missing seam.** The shipped `web` profile does **not** compose `@deepseek-ai/dsh-authorization`, and `dsh-llm-pi-ai` registers its sign-in flows inside `ctx.inject(['authorization'], …)`. Without that service the adapter waits forever and **no provider's sign-in flow is ever registered** — which is exactly why the subscription plugins that do work each reimplement OAuth. This plugin's bundle patch brings the row, and that is what makes one generic console possible.
- **Unclaimed records are listed.** Records in the `llm-pi-ai` scope that no flow claims any more (the provider stopped shipping a login, or the plugin offering it was removed) get their own section, deletable in one click. The seam's own documentation says identifying those orphans is the caller's job; nobody was doing it.
- **It is honest.** Signing out deletes the local record and the UI says so rather than implying revocation; unpriced things are not shown; a host with no flows renders "no sign-ins are available" instead of a button that cannot work.

## Security

- **Every request goes through `ctx.connection.requestRejection()` first**: the Host/Origin fence (defeats DNS rebinding and cross-site calls) plus browser authentication. A naked request gets **401**, not 200.
- **No secret ever passes through this plugin.** It calls `describeRecord()`, whose return type has no field a value could ride in. The flows themselves run inside `dsh-llm-pi-ai`, the only writer, and commit straight into the harness credential store.
- **Allow-list projection of notices.** Only `message`/`url`/`code` survive; anything else is dropped, with a test watching.
- **Deliberately narrow deletion.** Only `llm-pi-ai/<provider>` records are listed or deletable. Records written by other plugins are neither shown nor removable here.
- **64 KiB request-body ceiling**; a non-JSON body is a 400, not a crash.

## Install

```sh
dsh plugin --profile web add dsh-subscription-login
```

Then **restart `dsh web`**.

> ⚠️ The restart is required. The bundle patch inserts two rows (the authorization seam and this plugin), and the profile patch's hot reload did **not** pick up an out-of-process file write in testing — see "How far this was verified" below. After changing `dsh.profile.bundles`, a cold start is the only reliable path.

Then open **Settings → Plugins → Subscriptions**.

## Using it

Each row is one account you can sign into:

- **Sign in** — the flow tells you which page to open and which code to enter; questions it cannot answer for itself (paste a code, pick an account) appear in place. **Cancel sign-in** withdraws the attempt at any point.
- **Sign out** — two-step confirmation. Deletes the local record only.
- **Unclaimed records** — stale records no flow claims, deletable.

Once signed in, the official **Settings → Models** page shows the provider row and its credential state: this plugin reuses that path rather than inventing a second model catalog.

## What it does not do

- **No OAuth implementation of its own.** The protocols live in pi-ai, along with refresh and cross-process locking. This plugin is the surface and the orchestration.
- **No server-side revocation.** The seam has no revocation channel; signing out forgets the record locally.
- **No resumable sign-ins.** An attempt lives only in the process that started it; a page reload means starting over. That is a seam constraint, not a choice here.
- **No opinions.** It does not recommend a provider, track quotas, or run health checks.

## Development

```sh
npm test      # 52 offline tests
npm run check # release guard, run automatically by npm publish
```

**There is no build step.** `lib/client.js` is hand-written in the client module format (`window.__ModuleLoader__.load` with a factory), and the file in the repository is the file that ships and the file that runs. `require("react")` resolves through the shell's static module table.

The tests run in Node — no browser, no DSH install — in four layers:

| File | Covers |
|---|---|
| `test/registry.test.mjs` | The sign-in lifecycle: notices, prompts, answers, raced withdrawals, cancel, timeout, failure, sign-out, unmount — against stubs implementing the seams' **documented** contracts, not this plugin's expectations |
| `test/router.test.mjs` | HTTP shape: statuses, codes, cursor and timeout clamping, route matching |
| `test/host.test.mjs` | `apply()` wired to a stub Cordis context; **the trust fence runs before anything else** (a rejected request never reaches the seams); body parsing and its ceiling; unmount cancels a running sign-in |
| `test/client.test.mjs` | The real `lib/client.js` against a stub `window.__ModuleLoader__` and a stub React: registration, dictionary parity, rendering, and **clicking sign-in to walk a whole attempt** through to the question it is asked |

## How far this was verified

**End-to-end verification is done**, and it was done without disturbing anything: a second instance on an **isolated `DSH_HOME`** (port 3099, its own session storage), probed, then shut down and deleted. Your running server was never touched.

Live results:

| Probe | Result |
|---|---|
| Naked `GET /plugins/dsh-subscription-login/flows` | **401** ✅ route registered, trust fence runs before anything else |
| Same path with a session cookie | **200** with a real payload ✅ |
| Naked `POST .../attempts` | **401** ✅ the write path is fenced too |
| Unknown flow | `404 NO_FLOW` ✅ |
| Unknown method | `400 UNKNOWN_METHOD`, listing the real `oauth, api-key` ✅ |
| Sign-out of a foreign scope | `404 NO_RECORD` (does not leak whether that record exists elsewhere) ✅ |
| Missing key | `400 BAD_REQUEST` ✅ |
| Unknown path under the prefix (with cookie) | `404 NOT_FOUND` ✅ |

**The most valuable result**: `flows` returned **40 provider sign-in flows** — direct proof of the diagnosis. Without the patch's authorization row, **none** of those 40 would exist. Six of them carry OAuth:

`anthropic` (Claude Pro/Max), `openai-codex` (ChatGPT Plus/Pro), `github-copilot`, `openrouter`, **`kimi-coding`** (Sign in with Kimi Code), **`xai`** (SuperGrok / X Premium).

The last two I did not know about. Every plugin that hardcodes its provider list misses them — which is the payoff for reading the list from the seam instead.

**The live run also caught a real bug.** `dsh-host-webserver` matches a prefix route with `pathname === prefix || pathname.startsWith(prefix + '/')`. I had registered the prefix as `/plugins/dsh-subscription-login/` — *with* a trailing slash — so the matcher looked for `...//flows` and **never matched**; only the bare path hit, and every real endpoint fell through to the SPA fallback as a 404. The first probe showed exactly that (`/plugins/dsh-subscription-login/` → 401 but `/flows` → 404). Fixed, and `test/host.test.mjs` now pins the constraint.

### A real provider's full OAuth (GitHub Copilot, 2026-09-18)

A free GitHub account ran a real device flow end to end on the user's own DSH instance, driven entirely through this plugin's HTTP surface:

| Step | Observed |
|---|---|
| Flow list | **39 flows**, **6 with OAuth**: Anthropic / GitHub Copilot / Kimi For Coding / OpenAI Codex / OpenRouter / xAI |
| Start | `POST attempts` → `attemptId=a1` ✅ |
| Flow **asks** | `GitHub Enterprise URL/domain (blank for github.com)` ✅ |
| Answer | empty → `{"ok":true}`, flow continues ✅ |
| Flow **notifies** | `https://github.com/login/device` plus code `03B3-2CA7` ✅ |
| Human authorizes on GitHub | succeeded (GitHub confirmed the session as `woodfood111`) ✅ |
| Copilot token exchange | **403** with a structured reason: `no_copilot_access`, `can_signup_for_limited: true` ✅ reported faithfully |
| Post-failure consistency | no half-written record, no orphans, key released for an immediate retry ✅ |

In other words **every step of the human-in-the-loop round trip was exercised against a real provider flow**, and the only failure was the entitlement itself — the expected outcome for a free account. That 403 carries a `notification_id` and a sign-up link, which is the point: **failures here are diagnosable rather than a silent hang**, the difference between this plugin and one that reimplements OAuth.

The run also improved how a refusal is presented: the provider's text is printed verbatim in its own diagnostic block (monospace, wrapped, untruncated) instead of as a muted grey line — **not trimmed, not paraphrased**, because rewriting a provider's words would be inventing an answer.

### End to end: a real credential written into the profile (OpenRouter, 2026-09-18)

This was the last gap. A real account, on the desktop running DSH, through PKCE and a loopback callback:

| Step | Observed |
|---|---|
| Start | `attemptId=a9` ✅ |
| Flow notifies | listening on `127.0.0.1:1960/oauth/callback/<uuid>`, authorization URL given ✅ |
| Human authorizes in the browser | Authorize clicked ✅ |
| **Loopback callback** | browser hit `127.0.0.1:1960` and the **local listener caught it — nothing to paste** ✅ |
| PKCE exchange + record commit | completed ✅ |
| **Settlement** | `outcome=authorized` ✅ |
| **Credential stored** | `openrouter: configured=true, kind=grant` ✅ |
| Consistency | no orphans, no in-flight residue ✅ |

**That is proof it works, not proof that it ought to.**

The run also exposed a UI gap, now fixed: **a successful sign-in is not the same as a selectable model.** The credential goes into the credential store, while the model selector reads `llm-pi-ai` **routes** — and `settings.yaml` had no `openrouter` section. The success message now adds that step: if the provider is not in the model list yet, add it as a route in Settings → Models. This plugin deliberately does not touch model catalogs — that is the official Models page's job — but it has to say so.

Still unverified:

- ⚠️ **The client UI has only ever rendered under a stub React, never in a real browser**: layout, styling, and whether the browser's fetch actually reaches the host are yours to confirm by opening the page. The successful run above was driven through the HTTP surface, which is every step the UI performs, but it did not go through the UI's buttons.
- ⚠️ **GitHub Copilot never reached success**: the account has no entitlement and, from China without a proxy, the Copilot sign-up page is unreachable. The device flow itself was verified in full (above).

## Getting to a genuinely successful login

That 403 carried `can_signup_for_limited: true` and a sign-up link, so the last step is short:

1. Sign up for free **Copilot Free** at <https://github.com/github-copilot/signup> (no payment needed)
2. Back in **Settings → Plugins → Subscriptions**, click sign-in on GitHub Copilot again
3. Same device flow, this time it writes the credential; Copilot's models then appear in **Settings → Models**

Or use **OpenRouter**: its OAuth is PKCE, free accounts complete it, and it returns your own API key without consulting a subscription — that route validates the "credential actually written" path directly.

## Listing it

To get into the market, send a PR to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (PRs to the market itself do nothing — the market only reads that list). `npm run check` before publishing blocks five classes of accident: the host half importing `@deepseek-ai/*`, the client half requiring anything but react, the two dictionaries disagreeing, the patch losing the authorization seam, and failing tests.

## License

MIT
