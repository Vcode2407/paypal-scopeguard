# Run and review ScopeGuard

ScopeGuard is a local, MIT-licensed application. Its fictional sample and deterministic quote workflow run without an account or API key. Optional live AI and PayPal sandbox flows need separate account-owner setup. A successful local demo does not establish those integrations have run.

The [silent local walkthrough](videos/local-walkthrough.mp4) takes 2:17. [Its disclosure and written walkthrough](LOCAL_DEMO.md) identify exactly what was recorded and the live integrations still pending. The actual screen footage and recording captions remain unchanged; its audio track has been removed.

## Reproduce the available workflow

Use Node.js 22 or newer on Windows or Linux. From a fresh checkout:

```powershell
git clone https://github.com/Vcode2407/paypal-scopeguard.git
cd paypal-scopeguard
npm ci
npm run check
npm test
npm run demo:verify
npm start
```

Open `http://127.0.0.1:4185`. If the port is already occupied, stop the other instance first or set `PORT` to an unused local port. ScopeGuard binds to the loopback interface.

1. Keep **Local rules** selected. The provider label explicitly identifies this source as having no AI model.
2. Review the four fictional scope clauses and three editable client requests.
3. Compare requests. The FAQ page and booking integration should cite C3/C4 as extra-work suggestions. The headline-colour edit cites C1/C2 and remains included, subject to the revision limit.
4. Inspect the clause text beside each suggestion. Select only the FAQ page and booking integration for the estimate.
5. Keep their four-hour and six-hour estimates and a $50 hourly rate. Preview the itemized **$500** quote.
6. Approve the exact reviewed preview. This is the operator's local review, not authenticated client acceptance.
7. Export the JSON evidence. It records the fictional scope, source, reviewed assessment and quote. No PayPal invoice has been created by these steps.

Assessments and quotes are in memory and expire. Restarting clears them. The current fixed agreement cannot be replaced through the interface; this prototype demonstrates one bounded freelancer workflow.

`npm run demo:verify` verifies this HTTP workflow in an isolated server with provider traffic explicitly forbidden. It saves labelled evidence to ignored `artifacts/local-demo-evidence.json`; both `liveAiUsed` and `actualPayPalInvoiceCreated` are false. This reproducible local artifact is separate from the actual live sponsor evidence still required.

## Automated evidence

`npm test` currently passes **50 tests** locally. Provider responses are synthetic. The suite checks input limits, supplied-clause grounding, deterministic cents, approval fingerprints, expiry/origin protection, PayPal draft/status/error behavior, optional SIWC authentication/renewal races and the guarded one-shot evidence command. It also exercises real Windows credential-file ownership/DACL handling and rejects redirected credential directories in temporary fixtures. These tests do not perform live inference or call PayPal accounts.

The public GitHub Actions workflow runs installation, syntax checks, tests and the account-free reproduction on Node 22 with both Ubuntu and Windows. Actions are pinned to verified upstream release commits and the workflow requires no sponsor secrets. The [47-test hosted baseline](https://github.com/Vcode2407/paypal-scopeguard/actions/runs/38074868067) completed successfully at commit `2e356d1` on both operating systems. Check the [latest workflow run](https://github.com/Vcode2407/paypal-scopeguard/actions/workflows/ci.yml) for subsequent commits; local results are not substituted for hosted results.

## Optional meaningful AI verification

The [ChatGPT connection guide](CHATGPT_PLAN.md) explains local Sign in with ChatGPT. The account owner must complete the official browser sign-in and consent flow. Load account-returned models, select one, and explicitly choose the ChatGPT source before comparing requests. The source remains unavailable until the required plan permission and model selection exist. An account sign-in is not itself AI inference evidence.

Alternatively, set a valid Nebius Token Factory API key and explicit account-available model in ignored `.env`, then explicitly select Nebius. This can incur that account's provider charges. ScopeGuard does not silently switch to a billable provider or claim a local-rule result came from AI.

An accepted live assessment records the actual provider/model and separate requested/returned model provenance. Retain a sanitized export and public demo footage showing a completed, grounded result. Never include API keys, OAuth tokens, authorization URLs or private account details in screenshots, videos or repository files.

For one reproducible fictional assessment after owner consent and model selection, run `npm run evidence:chatgpt -- --confirm-plan-use`. This explicit action consumes that account's plan allowance, dispatches at most one assessment, refuses incomplete setup and saves whitelisted evidence to ignored `artifacts/chatgpt-live-evidence.json`. It never creates invoices or falls back to Nebius. [Exact behavior and disclosure](CHATGPT_PLAN.md#capture-one-fictional-live-assessment).

## Optional real PayPal sandbox verification

The account owner needs a [PayPal sandbox developer application](https://developer.paypal.com/api/get-started/), a sandbox business account with Invoicing access and a sandbox buyer. Put only the sandbox client ID/secret into the ignored `.env` file and restart. Check the UI's configured state; it does not prove OAuth or Invoicing access has succeeded.

Approve a reviewed quote, enter the sandbox buyer email, and create a sandbox draft. Verify the returned invoice ID, actual status and authoritative USD total. This adapter creates drafts and reads status; it does not send invoices or make payments. To show payment lifecycle, the owner sends and pays manually in the sandbox accounts, then refreshes the actual returned status in ScopeGuard. On an uncertain creation outcome, inspect the sandbox dashboard before creating another quote. [PayPal Invoicing](https://developer.paypal.com/api/invoicing/).

Do not use real seller credentials, customers or money. The implemented endpoint is fixed to PayPal's sandbox. Keep sandbox login/API details out of the public repository; any required private judge-access instructions belong in the competition's private access field.

## Remaining submission gates

At the latest local check, ChatGPT was prepared but unconnected, no model was selected, and both Nebius and PayPal were unconfigured. Actual AI attempts and verified AI calls were zero. The account owner still needs to complete the meaningful AI run, real sandbox invoice/payment/status evidence, public YouTube video under three minutes, and the Devpost entry/declarations.

Free, unrestricted judge access through the judging period still needs an explicit final arrangement. The account-free local workflow is reproducible now; requiring every judge to buy their own eligible AI plan would not establish free access to the live integration. Provide the organizer-approved access arrangement or verified live demonstration and private setup instructions required by the final rules. [Official PayPal AI Hackathon rules](https://paypalaihackathon.devpost.com/rules).

The submission deadline is **November 13, 2026, 01:30 IST** (November 12, noon PST). The project has not been submitted. Keep these disclosures current after real verification and publication.
