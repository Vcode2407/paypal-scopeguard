# ScopeGuard — Devpost submission draft

**Status:** Working local prototype. Live AI inference and real PayPal sandbox invoice creation have not been verified. This document is a draft; the project has not been submitted.

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

The PayPal adapter is implemented for sandbox draft creation and status reconciliation. With appropriate sandbox credentials, it obtains an OAuth token, creates an itemized invoice, reads its details, and checks that its USD amount matches the approved quote. The application does not send invoices or execute payments. Sending and paying would be demonstrated manually in the sandbox accounts, followed by a status refresh in ScopeGuard.

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

**Reporting provider failure accurately.** AI failures are shown as errors and do not silently become local-rule assessments labelled as AI. Tests check sanitized failures, expired quotes, and rejection of untrusted browser origins. The current workflow suite passes; all provider responses in these tests are stubs.

## What the implementation taught us

A useful scope assistant needs more than a classification. The reviewer needs the exact clause and the original request, while pricing needs its own deterministic calculation. Invoice creation also needs a recovery path: an interrupted response is not evidence that no invoice exists. These lessons shaped the review step, quote fingerprint, and separate status reconciliation action.

## AI and integration disclosure

- **Default runtime:** Local rules; no AI model request and no PayPal connection.
- **Implemented optional runtime AI adapter:** Nebius Token Factory, requiring a valid `NEBIUS_API_KEY` and an explicit model available to that account. Actual model access, inference quality, and an end-to-end run remain unverified.
- **Implemented optional Sign in with ChatGPT path:** Eligible plans can power the local app after the user completes their own sign-in, grants plan-use permission, and selects a model from the account's returned catalogue. Private backend storage, callback validation and the inference path are locally tested with provider stubs. Public authorization metadata was checked, but no actual user consent or plan inference has been verified. Judge setup still needs a real run. Requested and returned model identities are recorded separately.
- **PayPal:** Sandbox Invoicing adapter implemented and tested with stubs. No real sandbox invoice or sandbox payment has been verified.
- **Development assistance:** Codex assisted development. Confirm any model/version and other development-tool details requested by the final submission form. Development assistance is separate from the runtime AI demonstration still to complete.

## What is next

First, verify a meaningful runtime AI assessment on actual requests and record the provider and model used. Then create a real PayPal sandbox invoice, compare its amount with the approved quote, manually exercise the sandbox payment lifecycle, and refresh the returned status.

The [MIT-licensed repository is public](https://github.com/Vcode2407/paypal-scopeguard). Before submission, complete live integration verification, finalize free judge access, and record the verified workflow. The [local judge walkthrough](JUDGES.md) is available now. Later product work would add editable agreements, durable invoice recovery records, revision-history tracking, and a separate client approval experience.

## Demonstration outline — 2 minutes 40 seconds

Record the AI and PayPal portions only after real integration verification. Until then, any recording must explicitly identify local rules and stub-only integration validation.

| Time | Footage and on-screen captions |
| --- | --- |
| 0:00–0:20 | Show the fictional landing-page agreement and the three client requests. Explain the freelancer's decision about additional work. |
| 0:20–1:00 | Run the verified AI assessment, display the actual provider/model, and inspect the clauses. Explain why the colour edit is included while the FAQ page and booking integration are extra-work suggestions. |
| 1:00–1:35 | Review the selected estimates and $50 hourly rate. Show the $500 preview, then approve that exact quote locally. |
| 1:35–2:20 | Create the real sandbox draft and show its returned ID, status, and verified amount. Show the manually completed sandbox payment step, then refresh the actual status in ScopeGuard. |
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
| Runtime AI evidence | **Pending.** Record actual provider, model, request example, and observed output. |
| PayPal evidence | **Pending.** Record the actual sandbox invoice, matching amount, and refreshed payment status. |
| Entrant / team details | **Pending human completion.** Confirm names, roles, eligibility, and required declarations. |
| Devpost project / submission URL | **Pending.** No submitted entry is claimed. |

## Setup and submission readiness

From the repository root, install pinned dependencies with `npm ci`, start with `npm start`, and open `http://127.0.0.1:4185`. Run `npm test` and `npm run check`. The [README](../README.md) describes the local sample, optional ChatGPT sign-in, and Nebius/PayPal configuration. Sponsor API credentials belong in the ignored `.env` file; ChatGPT sign-in credentials stay in the app's protected ignored store.

The event requires meaningful integration with PayPal's free sandbox and an AI tool/model/platform. It accepts a working hosted demo or complete local run instructions, requires public open-source code, English materials, and a public YouTube demonstration under three minutes. Deadline: **November 13, 2026, 01:30 IST** (November 12, noon PST). Arrange unrestricted, free judge access through the judging period ending **December 15, 2026**. [Official rules](https://paypalaihackathon.devpost.com/rules)

The public repository and local setup are available. The local prototype alone does not establish completion of all requirements. Live AI and PayPal verification, public video, final judge access, and the submission itself remain pending.
