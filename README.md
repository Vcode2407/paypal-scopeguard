# ScopeGuard

A freelancer change-order assistant for the **PayPal AI Hackathon**. Compare incoming requests with an agreed scope, inspect exact clause evidence, review itemized pricing, and create a PayPal sandbox draft invoice. Prices come from user estimates and an hourly rate, never from model output.

## Run locally

Node 22 or newer. The pinned `jose` dependency validates OpenAI identity tokens; all other runtime components use Node's built-in APIs.

```powershell
npm ci
npm start
npm test
npm run check
```

Open http://127.0.0.1:4185. Compare the built-in requests: an additional FAQ page and booking integration are extra-work suggestions, while a headline-colour edit is included subject to revision limits. Review the actual clauses, select the extra work, preview the $500 total at $50/hour, and approve the quote. Export the JSON evidence.

Default mode uses bounded local rules and **no AI model or PayPal connection**. Assessments and approvals are temporary and disappear on restart. The fixed agreement is fictional; this prototype assists review and does not determine contractual rights.

## Configure real AI and PayPal sandbox

Copy `.env.example` to ignored `.env`. Restart after editing.

- **Use your ChatGPT Pro plan:** choose **My ChatGPT plan** as the assessment source and prepare sign-in. Open **Continue with ChatGPT**, review the requested permission to use your plan, and complete sign-in yourself. Return to ScopeGuard, refresh the connection, load the models returned by your actual account, and select one. Comparing the requests then sends this fictional scope and the entered request text to OpenAI using your eligible plan allowance. Choose an existing saved sign-in when reconnecting; issued registrations remain available for recovery after a failed attempt. Cancel a pending sign-in from the same panel. No API key is required for the official local/open-source sign-in flow. Credentials stay in protected backend storage; the browser never receives tokens. If private storage cannot be established, this option is unavailable and the local workflow still starts. See [setup, security boundaries and current validation](docs/CHATGPT_PLAN.md). No live sign-in or plan inference has been verified.
- **Alternatively use Nebius:** configure `NEBIUS_API_KEY` and an explicit `NEBIUS_MODEL` available in your account, then select Nebius as the assessment source. The backend calls Token Factory chat completions, validates the resulting request classifications, and grounds citations in the supplied scope. Requested and provider-returned model identities are kept separate. A failure is reported; it does not silently turn a rule-based result into an AI result. Provider requests incur the selected account's charges. No live inference has been verified.
- **Local rules remain the default**, even when another provider is configured. Changing the source clears the old assessment and quote, and an AI source without access fails rather than silently running local rules. Model output cannot set prices, approve quotes, create invoices, or choose tools.
- PayPal: use [Developer Dashboard sandbox credentials](https://developer.paypal.com/api/get-started/), `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_SECRET`. A sandbox business account with Invoicing enabled and a sandbox buyer are needed. Credentials remain on the backend. The endpoint is fixed to `https://api-m.sandbox.paypal.com`; there is no live mode.
- After approving a quote, enter the **sandbox buyer account email** and click **Create PayPal sandbox draft**. The adapter authenticates with OAuth, creates an invoice with a retained request ID, reads its actual status, and verifies the returned total. It never sends invoices or records fabricated payments. A known invoice ID survives a failed status lookup; an unknown creation outcome blocks another automatic POST. A request ID alone is not assumed to guarantee Invoicing API deduplication. Check the sandbox dashboard before creating a new quote after an uncertain result.
- To demonstrate payment lifecycle, send/pay the invoice manually through your sandbox accounts and refresh its actual status in ScopeGuard. This application's current integration supports draft creation and status reconciliation; sending and checkout are outside its implemented scope.

References: [PayPal Invoicing quickstart](https://developer.paypal.com/api/invoicing/), [Invoices v2 reference](https://developer.paypal.com/api/invoicing/v2), [REST request/idempotency guidance](https://developer.paypal.com/api/make-api-requests), [Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart), [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart).

## Validation and submission gates

Meaningful tests cover clause grounding, actual HTTP workflow, deterministic totals, review fingerprints, non-billable requests, invalid estimates, provider failures, authoritative sandbox status, stable retries and origin/expiry checks. All provider responses in automated tests are stubs. **No real PayPal invoice or live AI request has been created.**

Deadline: **November 13, 2026, 01:30 IST**. [Official rules](https://paypalaihackathon.devpost.com/rules).

- [ ] Validate meaningful AI on actual requests and record the chosen model.
- [ ] Create an actual sandbox invoice, manually exercise the sandbox payment lifecycle, and verify the returned status/amount.
- [ ] Public licensed repository with runnable setup, source and assets.
- [ ] Working judge-accessible demo or complete local setup instructions.
- [ ] Public YouTube demonstration under three minutes and English project description.
- [ ] Complete Devpost fields and maintain judge access through the required period.

Recording outline: introduce scope creep (20s), classify the client request and inspect clauses (40s), review deterministic pricing (35s), create the real sandbox invoice and reconcile its sandbox payment status (45s), explain AI/PayPal boundaries and next steps (20s). Record only the flows that have actually been verified.
