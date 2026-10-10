# Optional ChatGPT plan connection

ScopeGuard includes a local Sign in with ChatGPT provider. It is prepared and tested with synthetic provider responses. No real account sign-in, consent, model discovery or inference has been performed during development. A public, unauthenticated discovery probe returned HTTP 200 and matched the documented issuer, authorization, token and JWKS endpoints on October 10, 2026; that probe is not evidence of account access or AI use.

The documented open-source/local flow supports eligible ChatGPT Plus and Pro users through dynamically issued application registrations. A subscription does not establish that this installation has completed registration, received permission, or has an available model. Remotely hosted commercial integrations have a different access process. This implementation is for the local ScopeGuard application. [OpenAI quickstart](https://developers.openai.com/siwc/quickstart), [local plan usage](https://developers.openai.com/siwc/token-sharing-open-source).

## Use the local application

Run Node 22 or newer, install the captured dependencies with `npm ci`, then run `npm start`. Open `http://127.0.0.1:4185`. Local rules remain the default source and work without an account.

1. Select the ChatGPT plan source and choose a saved registration or a new account.
2. Prepare sign-in, then open **Continue with ChatGPT** yourself. Review the account, application name and requested permissions on the OpenAI page.
3. Return to ScopeGuard and refresh connection status. An identity connection alone does not enable inference: both `resource.invoke` and `chatgpt.tokens.use.direct` must be granted.
4. Load models from the connected account and select an actual returned model. No model name is supplied as a fallback.
5. Compare the fictional sample requests. This explicit action dispatches inference. Review the returned clause evidence before preparing a quote.
6. Disconnect when finished. If remote revocation cannot be confirmed, remove ScopeGuard’s access in ChatGPT settings as well.

Do not paste ChatGPT passwords or tokens into ScopeGuard. Do not copy another application’s authentication files. The implementation never reads Codex authentication files. Account login and permission decisions remain in the browser on OpenAI’s authorization endpoint.

Returning sign-in reuses the issued client ID and stable host ID. Registrations whose code exchange failed are kept as **sign-in needed** so a retry can reuse the same issued registration. New credentials become active only after validating the corresponding identity. The app deliberately omits an ID-token hint from the browser-facing authorization URL; returning users may therefore see an account selector. It still requires the same validated subject for that registration. The documented flow explains this selector behavior. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

## Security and request behavior

The backend creates the loopback listener before preparing authorization. Each attempt has fresh random state, nonce and S256 PKCE values. The exact callback is `http://127.0.0.1:<ephemeral-port>/auth/callback`; ScopeGuard’s main port stays 4185. The same callback URI is used for the code exchange. Duplicate or expired callbacks fail, and cancellation cannot publish credentials during a pending private-store write. The `jose` library validates the ID token against the public JWKS, expected issuer, issued client audience, expiry, nonce and subject. The authorization URL contains one-time state: do not log it or callback URLs. [Sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [OpenAI identity validation](https://developers.openai.com/siwc/website).

Application credentials live only in `data/chatgpt-plan/connection.json`, under the existing ignored `data/` directory. Writes are atomic. Unix permissions are directory 0700/file 0600. On Windows, the dedicated directory and existing credential file receive protected DACLs limited to the current user and SYSTEM; current ownership is verified and preserved. Permission setup failures disable the optional connection. These are protected plaintext local files, not an encrypted credential vault. A process lock prevents two ScopeGuard processes from racing rotating tokens. Remove a stale lock only after verifying its owning process is stopped.

Each registration keeps separate identity and credentials. Refreshes are serialized, replacement tokens are saved, and a prior session’s renewal cannot overwrite a newer sign-in. Sign-out first blocks inference, waits for an in-flight rotation, then revokes the latest renewable token. Local credentials are cleared even when remote revocation is unavailable, with that limitation shown explicitly. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Model discovery uses `GET https://api.openai.com/v1/models` with the same OAuth token used for inference. The picker uses only account catalog entries with display visibility, preserving their ordering. Inference uses the public `POST https://api.openai.com/v1/responses`, with `store:false`, `stream:true`, an input array and developer instructions. No hosted tools, payment actions or external data access are exposed to the model. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Acceptance requires a `response.completed` event, valid actual model metadata, a bounded JSON assessment and evidence referencing the supplied request/clause IDs. Failed, incomplete, interrupted, oversized or ungrounded responses do not create assessments. Requested and returned model IDs are preserved separately; `modelMatchesRequested` reports exact equality. OpenAI documents model aliases and snapshots, so this application does not infer an alias mapping or relabel the provider’s actual model ID. [Responses model metadata](https://developers.openai.com/api/reference/resources/responses/methods/retrieve), [OpenAI model aliases and snapshots](https://developers.openai.com/api/docs/models/gpt-5.4).

The default process budget is ten inference attempts with one assessment in flight. Failed dispatched inference counts toward that budget; identity/model preflight failures do not. There are no automatic inference retries. Requests have a 20-second deadline, 96 KB stream cap and 16,000-character accepted text cap. The model is asked to be brief. The plan preview does not support `max_output_tokens`, so these local limits are not a guaranteed provider token or billing ceiling. Review plan usage and app limits in [ChatGPT Settings → Usage](https://chatgpt.com/#settings/Usage). [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Verification and submission evidence

```powershell
npm test
node --check src/chatgpt-plan.js
```

The new provider tests use a locally generated RSA key, synthetic signed ID tokens, a real loopback callback, injected provider responses and temporary credential storage. They verify PKCE/state/identity checks, permission denial, account-specific model selection, incomplete streams, missing model identity, actual provenance, attempt limits, rotating tokens, stale renewal, cancellation during persistence, revocation failure and Windows ownership/DACL behavior. They perform no account or inference calls.

`node src/chatgpt-plan.js` is a safe preparation diagnostic: it initializes protected app metadata and prints sanitized connection status, then releases the lock. It does not start sign-in or perform inference. Close the running ScopeGuard server before using it, since the connection is single-owner.

Status distinguishes preparation (`configured` on the connection), validated identity (`connected`), granted plan permission (`sharing`), selected account model, dispatched attempt count and accepted inference count. The assistant’s `configured` getter requires sharing permission plus a selected model. `verifiedInferenceCalls` begins at zero for every process and increases only after a completed, validated assessment. `lastVerifiedInference` retains the actual request/response provenance without credentials. Synthetic tests and public discovery never increase the real application’s inference count.

Before claiming meaningful live AI use in a hackathon submission, complete the actual consent flow and retain a sanitized successful assessment showing its requested model, returned model, completed-response ID and grounded scope evidence. Verify the sponsor’s separate PayPal sandbox requirements through the project’s main README. This provider does not satisfy payment integration evidence by itself. Public repository publication, actual model access, user-specific eligibility, live OAuth/refresh behavior and live AI inference remain unverified until performed by the account owner.

## Integration API

```javascript
import { ChatGPTPlanConnection, ChatGPTPlanAssistant } from './src/chatgpt-plan.js';

const connection = await ChatGPTPlanConnection.create(); // no network call
const assistant = new ChatGPTPlanAssistant({ connection, maxCalls: 10 });
// Explicit user actions only:
// await connection.startSignIn({ accountId });
// await connection.listModels();             // [{slug, displayName}]
// await connection.selectModel(slug);
// await assistant.assess(requests);
// await connection.cancelSignIn();
// await connection.disconnect();
// await connection.close();
```

Serve sanitized `status()` through the existing local application. Expose connect, cancellation, model/account selection and disconnect through guarded same-origin POST routes. `selectAccount(accountId)` accepts only validated identities; a registration with `validated:false` can be reauthorized with `startSignIn({accountId})`. Await cancellation before reporting success. Initialization failure should keep local rules available and display the optional-provider error. Do not serialize the connection, credential store or internal record to the browser, and do not log authorization URLs, codes or provider credential payloads.
