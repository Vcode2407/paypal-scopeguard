# ScopeGuard — Devpost submission draft

**Status:** Working local prototype. Actual ChatGPT consent, connection and model discovery were verified on October 11, 2026. Two separately authorized inference attempts across October 11–12 failed with `STREAM_INVALID`; zero live assessments were accepted. The second recorded provider HTTP 200 with a missing content-type header and cancelled the body without reading it. Meaningful AI output and real PayPal sandbox invoice creation remain unverified. This document is a draft; the project has not been submitted.

## Project name and tagline

**Name:** ScopeGuard

**Tagline:** Turn new client requests into reviewed scope evidence, clear pricing, and a PayPal sandbox invoice.

## Inspiration and problem

The product idea starts with a small freelancer project: a client asks for a new FAQ page, a booking integration, and a headline-colour change. These requests sound similar in a message, but they have different implications for the agreed work. A freelancer needs to connect each request to the agreement before estimating extra work.

ScopeGuard puts that connection next to the price. The aim is to make the conversation about additional work clearer: which clause applies, which requests need a separate estimate, and what the proposed change order costs. This is a product hypothesis illustrated with a fictional agreement. Customer research and measurable business outcomes remain future validation work.

## What it does

ScopeGuard compares editable client requests with four clauses in a fictional landing-page agreement. Each assessment labels a request as included, a change-order suggestion, or needing review, and displays the supplied clause text beside its explanation.

The current default uses local rules. The sample FAQ page and booking integration are suggested as extra work under the additional-pages and third-party-integrations clause. The headline-colour edit is treated as included, subject to the agreement's revision limit. The operator reviews these suggestions and selects the extra work to quote.

Prices come from the operator's estimated hours and hourly rate. Four hours for the FAQ page plus six hours for the booking integration at $50/hour produce a $500 preview. The model does not choose prices. The operator explicitly approves the exact preview before the backend permits invoice creation. This records local review; it does not capture authenticated client consent to a written change order.

The PayPal adapter is implemented for sandbox draft creation and status reconciliation. With appropriate sandbox credentials, it obtains an OAuth token, creates an itemized invoice, reads its details, and checks that its USD amount matches the approved quote. The application does not send invoices or execute payments. For an optional stronger payment-lifecycle demonstration, the owner would send and pay manually in the sandbox accounts, then refresh the actual returned status in ScopeGuard.

The browser can export the fictional scope, assessment, and quote as JSON. After an invoice response, the quote includes its latest returned status and verified amount. Failed or mismatched refreshes retain the known invoice ID with `STATUS_UNVERIFIED` and remove the previous amount. Current assessments and quotes live in memory and expire; restarting the server clears them.

## How it is built

The application uses Node.js 22 or newer, JavaScript, HTML, CSS, and the pinned `jose` library for OpenAI identity-token validation.

| Component | Responsibility |
| --- | --- |
| Browser interface | Editable requests, clause inspection, item selection, quote preview, local approval, sandbox invoice actions, and JSON export. |
| `src/domain.js` | Input limits, supplied-clause validation, deterministic cent-based pricing, quote fingerprints, expiry checks, and invoice-total verification. |
| `src/providers.js` | Local assessment rules, the optional Nebius Token Factory chat-completions adapter, and the PayPal sandbox OAuth/Invoicing adapter. |
| `src/chatgpt-plan.js` | Optional official Sign in with ChatGPT, protected per-app credentials, account-returned model selection, bounded Responses inference, and actual response provenance. |
| `src/server.js` | Local HTTP routes and orchestration of assessment, preview, approval, invoice creation, and status refresh. |
| `test/workflow.test.js` | HTTP workflow and provider-adapter regression tests using stub responses. |
| `tests/chatgpt-plan.test.js` and `test/source-selection.test.js` | Sign-in validation, private storage, returning-account recovery, cancellation/renewal races, source selection and completed-inference provenance with stub provider traffic. |

The AI adapter asks for structured classifications and supplied clause IDs. The backend rejects missing or unsupported evidence before creating a quote. The human reviewer still needs to check whether the cited clause supports the suggestion.

PayPal is intended to be central to the completed flow: the reviewed extra work becomes an actual sandbox invoice whose amount and status are checked against PayPal's response. The endpoint is fixed to the PayPal sandbox, and API credentials stay on the backend.

## Challenges addressed during development

**Keeping suggestions separate from billable work.** The workflow rejects included, duplicate, and unknown request IDs as quote items. Tests also reject invalid hour estimates before a provider is invoked and reject invented clause IDs in AI responses.

**Making approval refer to a specific price.** The quote includes a fingerprint of its items, currency, and total. The backend rejects approval with a different fingerprint and blocks invoicing an unapproved preview. Tests confirm the sample's $500 total and the approval boundary.

**Recovering from uncertain invoice creation.** A status lookup can fail after PayPal has created an invoice. The workflow retains a known invoice ID and rechecks its status and amount without creating a second invoice. If creation may have succeeded but no ID is known, another automatic creation POST is blocked so the operator can check the sandbox dashboard. Tests cover failed lookups, mismatched amounts, recipient changes, stable request IDs, and uncertain creation outcomes. A request ID is not treated as proof that the Invoicing API guarantees deduplication.

**Reporting provider failure accurately.** AI failures are shown as errors and do not silently become local-rule assessments labelled as AI. Tests check sanitized failures, expired quotes, and rejection of untrusted browser origins. The current **86-test local suite passes**; all provider responses in these tests are stubs.

**Bounding the optional Nebius path.** One assessment can run at a time. The default allowance is ten dispatched attempts per server process, including failed requests, timeouts and refused output. Configuration and concurrency refusals do not dispatch or consume a call. Requests have a 25-second deadline, 1,800 output tokens and a streamed 150,000-byte response limit; redirects are refused. Only `finish_reason: stop` with a valid, supplied-clause-grounded assessment is accepted. Restarting resets the allowance, so this is not a guaranteed billing cap. The `nebiusStatus` object in `GET /api/config` returns only configured state, attempt count, call limit, calls remaining and in-flight state, with no credentials.

**Separating catalog and inference limits.** ChatGPT model discovery allows at most 1 MiB (1,048,576 streamed bytes) and 500 entries, returning only valid visible model IDs/display names in their original order. Oversized streams are cancelled, and refused responses preserve the previous verified catalog. Loading or selecting a model does not dispatch inference. Authentication JSON stays capped at 64,000 bytes and inference streams at 96,000 bytes; the existing 20-second inference deadline is unchanged. The catalog regressions use injected responses and establish no actual account or runtime AI access.

**Diagnosing refused and malformed responses.** Ordinary assessments cancel unexpected-format and non-OK provider bodies unread. Sanitized status now retains request tracing and bounded timings. A separately authorized direct-library diagnostic can classify up to 4 KiB of a rejected BYOB byte stream within one second; UI assessments leave that mode off. Only fixed shape/status categories and enumerated error codes/parameters leave the classifier; raw bodies, free-form messages, account context and unvalidated headers are excluded. Missing MIME remains an error, and success still requires a completed, grounded SSE assessment. No retry or fallback is added. The first real attempt's status/type were not captured. The second recorded HTTP 200 with a missing header, cancelled its body unread, and established no cause. No new live request has run; [synthetic diagnostic coverage and boundaries](CHATGPT_PLAN.md#security-and-request-behavior) do not replace accepted integration evidence.

## What the implementation taught us

A useful scope assistant needs more than a classification. The reviewer needs the exact clause and the original request, while pricing needs its own deterministic calculation. Invoice creation also needs a recovery path: an interrupted response is not evidence that no invoice exists. These lessons shaped the review step, quote fingerprint, and separate status reconciliation action.

## AI and integration disclosure

- **Default runtime:** Local rules; no AI model request and no PayPal connection.
- **Implemented optional runtime AI adapter:** Nebius Token Factory, requiring a valid `NEBIUS_API_KEY` and an explicit model available to that account. Actual model access, inference quality, and an end-to-end run remain unverified.
- **Implemented optional Sign in with ChatGPT path:** Private backend storage, callback validation and inference are locally tested with provider stubs. On October 11, 2026, the owner completed actual consent, the app verified connection and plan sharing, and authenticated discovery displayed three models. `gpt-6-luna` was selected. The first authorized fictional request failed with `STREAM_INVALID`; HTTP status/type/cause were not captured. [First-attempt proof](evidence/chatgpt-connection-check-2026-10-11.json). A separately authorized diagnostic request on October 12, 2026, 09:17 IST failed with provider HTTP 200 and content-type category `missing`, cancelling the body without reading it. [Second-attempt proof](evidence/chatgpt-diagnostic-attempt-2026-10-12.json). That restarted process advanced from 0/0 to 1/0; the cumulative observed total is two attempts and zero accepted assessments. Neither check created an export or made PayPal actions. The second body format and underlying cause remain unknown. Requested and returned model identities will be recorded separately for an accepted result; no returned model or output is claimed for either failure. Any further inference needs another explicit owner decision and can consume plan allowance.
- **PayPal:** Sandbox Invoicing adapter implemented and tested with stubs. No real sandbox invoice or sandbox payment has been verified.
- **Development assistance:** Codex assisted development. Confirm any model/version and other development-tool details requested by the final submission form. Development assistance is separate from the runtime AI demonstration still to complete.

## What is next

First, verify a meaningful runtime AI assessment on actual requests and record the provider and model used. Then create a real PayPal sandbox invoice, compare its amount with the approved quote, and refresh the returned invoice status. Manually sending and paying in the sandbox can provide stronger lifecycle evidence; the [official rules](https://paypalaihackathon.devpost.com/rules) require central PayPal sandbox integration alongside AI and do not specify a completed payment as an entry condition.

The [MIT-licensed repository is public](https://github.com/Vcode2407/paypal-scopeguard). Before submission, complete live integration verification, finalize free judge access, and record the verified workflow. The [local judge walkthrough](JUDGES.md) is available now. Later product work would add editable agreements, durable invoice recovery records, revision-history tracking, and a separate client approval experience.

## Demonstration outline — 2 minutes 40 seconds

Record the AI and PayPal portions only after real integration verification. Until then, any recording must explicitly identify local rules and stub-only integration validation.

| Time | Footage and on-screen captions |
| --- | --- |
| 0:00–0:20 | Show the fictional landing-page agreement and the three client requests. Explain the freelancer's decision about additional work. |
| 0:20–1:00 | Run the verified AI assessment, display the actual provider/model, and inspect the clauses. Explain why the colour edit is included while the FAQ page and booking integration are extra-work suggestions. |
| 1:00–1:35 | Review the selected estimates and $50 hourly rate. Show the $500 preview, then approve that exact quote locally. |
| 1:35–2:20 | Create the real sandbox draft and show its returned ID, status, and verified amount. Refresh the actual invoice status. If the optional manual sandbox payment has been completed, show its actual returned status; otherwise keep the draft/status demonstration accurate. |
| 2:20–2:40 | Export the scope/assessment/quote JSON. State the current limits and the next product step. |

## Devpost fields and links to complete

| Field | Draft value or remaining work |
| --- | --- |
| Project name | ScopeGuard |
| Tagline | Turn new client requests into reviewed scope evidence, clear pricing, and a PayPal sandbox invoice. |
| Built with | Node.js, JavaScript, HTML, CSS; PayPal sandbox Invoicing adapter. Add the verified runtime AI provider/model after the live run. |
| Public repository | [Vcode2407/paypal-scopeguard](https://github.com/Vcode2407/paypal-scopeguard), public with MIT license. |
| Working build / judge instructions | [Account-free local walkthrough](JUDGES.md), starting at `http://127.0.0.1:4185`. Live provider access and final free judge-access arrangement remain pending. |
| Public YouTube video | **Pending URL.** Target duration: 2:40. |
| Local prototype walkthrough | [Actual silent recording, 2:17](videos/local-walkthrough.mp4). Local rules, no live AI or PayPal. [Disclosure/written walkthrough](LOCAL_DEMO.md). The original screen footage and recording captions remain; its audio track has been removed. This is separate from the final required YouTube demonstration. |
| Screenshots | [Actual local quote preview](images/local-quote.png). Live AI and actual sandbox invoice screenshots remain pending. |
| Runtime AI evidence | **Pending accepted result.** [Actual connection/first failure](evidence/chatgpt-connection-check-2026-10-11.json) and [second diagnostic failure](evidence/chatgpt-diagnostic-attempt-2026-10-12.json) record two attempts and no accepted output. Retain actual provider, requested/returned model, request example and grounded observed output after a successful authorized run. |
| PayPal evidence | **Pending.** Record the actual sandbox invoice, matching amount, and refreshed invoice status. A manually completed sandbox payment can add optional lifecycle evidence. |
| Entrant / team details | **Pending human completion.** Confirm names, roles, eligibility, and required declarations. |
| Devpost project / submission URL | [Saved ScopeGuard draft](https://devpost.com/software/scopeguard-lmpvyf), **2/5 steps**. Story and public source are saved; final video, additional information and submission remain pending. |

## Setup and submission readiness

From the repository root, install pinned dependencies with `npm ci`, start with `npm start`, and open `http://127.0.0.1:4185`. Run `npm test` and `npm run check`. The [README](../README.md) describes the local sample, optional ChatGPT sign-in, and Nebius/PayPal configuration. Nebius uses ignored `.env`; `npm run paypal:configure` saves PayPal credentials in ignored storage with Windows DPAPI CurrentUser encryption or Linux/macOS owner-only plaintext. Complete legacy PayPal environment credentials remain supported. [Setup boundaries](PAYPAL_SETUP.md). ChatGPT sign-in credentials stay in its separate protected ignored store.

The event requires meaningful integration with PayPal's free sandbox and an AI tool/model/platform. Public hosting is optional: complete setup and run instructions in the repository can provide access to a working local build, with any necessary testing-access details supplied privately. The event also requires public open-source code, English materials, and a public YouTube demonstration under three minutes. Deadline: **November 13, 2026, 01:30 IST** (November 12, noon PST). Arrange unrestricted, free judge access through the judging period ending **December 15, 2026**. [Official rules](https://paypalaihackathon.devpost.com/rules)

The public repository and local setup are available. The local prototype alone does not establish completion of all requirements. Live AI and PayPal verification, public video, final judge access, and the submission itself remain pending.
