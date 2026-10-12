# Optional ChatGPT plan connection

ScopeGuard includes a local Sign in with ChatGPT provider, tested with synthetic provider responses. On October 11, 2026, the account owner completed real sign-in and consent, and the app verified connection and plan-sharing permission. Authenticated model discovery displayed three models; `gpt-6-luna` was selected. The first authorized fictional assessment was refused with `STREAM_INVALID`; its HTTP status, content type and underlying cause were not captured. [First-attempt proof](evidence/chatgpt-connection-check-2026-10-11.json). A separately authorized diagnostic request on October 12, 2026, 09:17 IST was also refused: **HTTP 200, content-type category `missing`**. Its body was cancelled without reading it, so the body format and cause remain unknown. [Second-attempt proof](evidence/chatgpt-diagnostic-attempt-2026-10-12.json). The restarted process's counters advanced from 0/0 to 1/0; cumulatively there have been **two observed attempts and zero accepted assessments**. Neither check created an export or made PayPal actions. Successful live inference remains unverified.

A public, unauthenticated discovery probe returned HTTP 200 and matched the documented issuer, authorization, token and JWKS endpoints on October 10, 2026; that earlier metadata probe was not evidence of account access or AI use.

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

## Capture one fictional live assessment

After completing sign-in and plan consent yourself, loading the account catalog and selecting an available model, keep ScopeGuard running. To explicitly authorize one assessment using that selected account's plan allowance:

```powershell
npm run evidence:chatgpt -- --confirm-plan-use
```

Use `--port=4185` or another explicit local port if needed. The command reads only the local app's sanitized status and fixed fictional sample. It refuses unconnected accounts, missing plan permission, pending sign-in, missing model or exhausted budget before dispatching inference. It does not read credential files, initiate sign-in, grant permission, select models, switch providers or contact PayPal.

There is at most one assessment POST and no automatic retry or fallback. A successful result must identify actual ChatGPT use, preserve the exact selected/requested and returned model IDs, contain a completed response ID and grounded clause evidence, and advance the app's attempt/accepted counters by exactly one. A canonical returned model may differ from the selected alias; both IDs and their exact-equality flag are retained. The output is `artifacts/chatgpt-live-evidence.json`, ignored by Git. It contains the fictional inputs and a whitelisted assessment/provenance record, without account labels or credentials. Review it before sharing.

This command has only been tested with injected local API fixtures; it has not been used for the real UI attempts described above. A synthetic success is not live evidence. Run this command only when ready to use your actual allowance. Failures can consume the one dispatched attempt; resolve the reported issue before explicitly deciding to run it again. The first UI attempt and separately authorized diagnostic attempt have both been consumed; any additional inference needs another explicit owner decision. The command does not establish PayPal sandbox evidence.

## Security and request behavior

The backend creates the loopback listener before preparing authorization. Each attempt has fresh random state, nonce and S256 PKCE values. The exact callback is `http://127.0.0.1:<ephemeral-port>/auth/callback`; ScopeGuard’s main port stays 4185. The same callback URI is used for the code exchange. Duplicate or expired callbacks fail, and cancellation cannot publish credentials during a pending private-store write. The `jose` library validates the ID token against the public JWKS, expected issuer, issued client audience, expiry, nonce and subject. The authorization URL contains one-time state: do not log it or callback URLs. [Sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [OpenAI identity validation](https://developers.openai.com/siwc/website).

Application credentials live only in `data/chatgpt-plan/connection.json`, under the existing ignored `data/` directory. Writes are atomic. Unix permissions are directory 0700/file 0600. On Windows, the dedicated directory and credential file receive protected DACLs limited to the current user and SYSTEM. An existing current-user owner is preserved, including on Modify-only directories. Elevated Windows processes may create Administrators-owned objects by default; that case is accepted only for a current elevated administrator who can successfully assign and verify the current user's ownership. All unrelated owners are rejected. New temporary files receive private ownership/DACLs before credential content is written. [Windows object ownership](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object).

Ordinary Windows short-path aliases are supported; symbolic links and junctions anywhere in the credential directory's path are rejected. Permission setup failures disable the optional connection. These are protected plaintext local files, not an encrypted credential vault. A process lock prevents two ScopeGuard processes from racing rotating tokens. Remove a stale lock only after verifying its owning process is stopped.

Each registration keeps separate identity and credentials. Refreshes are serialized, replacement tokens are saved, and a prior session’s renewal cannot overwrite a newer sign-in. Sign-out first blocks inference, waits for an in-flight rotation, then revokes the latest renewable token. Local credentials are cleared even when remote revocation is unavailable, with that limitation shown explicitly. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Model discovery uses `GET https://api.openai.com/v1/models` with the same OAuth token used for inference. The application has a dedicated 1 MiB (1,048,576-byte) streamed catalog limit and rejects catalogs with more than 500 entries. Oversized responses are cancelled before additional bytes are read. The picker returns only valid model IDs and display names from entries with display visibility, preserving their ordering and excluding other provider metadata. A refused response does not replace the previous verified catalog. Catalog loading and selection do not dispatch inference. Authentication JSON retains its separate 64,000-byte limit, and inference retains its separate 96,000-byte stream limit. Inference uses the public `POST https://api.openai.com/v1/responses`, with `store:false`, `stream:true`, an input array and developer instructions. No hosted tools, payment actions or external data access are exposed to the model. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Acceptance requires a `response.completed` event, valid actual model metadata, a bounded JSON assessment and evidence referencing the supplied request/clause IDs. Failed, incomplete, interrupted, oversized or ungrounded responses do not create assessments. Requested and returned model IDs are preserved separately; `modelMatchesRequested` reports exact equality. OpenAI documents model aliases and snapshots, so this application does not infer an alias mapping or relabel the provider’s actual model ID. [Responses model metadata](https://developers.openai.com/api/reference/resources/responses/methods/retrieve), [OpenAI model aliases and snapshots](https://developers.openai.com/api/docs/models/gpt-5.4).

Ordinary assessments cancel unexpected-format and non-OK provider bodies without reading them. Every catalog/inference request now sends a fresh UUID `X-Client-Request-Id`. Sanitized `lastRequestDiagnostic` in connection status retains request kind, dispatch/response flags, HTTP status, fixed content-type category, client request ID, narrowly validated server request IDs and bounded header/total elapsed milliseconds. Server IDs are retained only as `req_` followed by 32–64 lowercase hexadecimal characters or a canonical UUID; other formats become `null`, which means not retained rather than necessarily absent. Authorization, account context, header parameters, status text and raw provider messages are excluded. Known failed SSE events may retain an exactly enumerated provider error code and parameter. [Official request tracing](https://developers.openai.com/api/reference/overview#debugging-requests), [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

A rejected-body classifier is available only for a deliberate direct-library diagnostic: after separate owner authorization, call `assistant.assess({ requests: SAMPLE, diagnosticRejectedResponses: true })` once. Ordinary UI/HTTP assessments and the existing evidence command do not enable it. The diagnostic sends the same assessment request; it changes only rejection inspection. A BYOB byte reader limits application reads to a total of 4,096 bytes, with a one-second sampling deadline and a bounded cancellation wait. Readers without BYOB support are cancelled unread; there is no ordinary-reader fallback that could deliver an oversized first chunk. This is an application read bound, not a transport download or token-spend guarantee.

The classifier exports only fixed categories (`empty`, `json_error`, `json_detail`, `json_other`, `sse_like`, `html_like`, `unknown`), sampled byte count, whether the prefix limit was reached, a fixed sampling-status category and exactly enumerated error codes/parameters. It does not export prefix bytes, free-form `detail`/`message` values, unknown codes or credentials. Prefix buffers are cleared after classification; JavaScript strings and application credentials still exist in process memory. No diagnostic authorizes a retry or account call by itself.

MIME matching accepts case and charset parameters but still requires the actual `text/event-stream` media type. An SSE-like diagnostic prefix with a missing MIME header remains refused. Malformed SSE events, incomplete/failed terminal events and invalid completion metadata stop subsequent stream reads; success still requires `response.completed` and grounded output. The first attempt's uncaptured status/type cannot be recovered retrospectively. The second actual attempt recorded HTTP 200 and a missing header, cancelled its body unread, and established no underlying cause; new synthetic diagnostics do not modify that historical evidence. No new live attempt has run. [Official streaming contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The default process budget is ten inference attempts with one assessment in flight. Failed dispatched inference counts toward that budget; identity/model preflight failures do not. There are no automatic inference retries. Requests have a 20-second deadline, 96 KB stream cap and 16,000-character accepted text cap. The model is asked to be brief. The plan preview does not support `max_output_tokens`, so these local limits are not a guaranteed provider token or billing ceiling. Review plan usage and app limits in [ChatGPT Settings → Usage](https://chatgpt.com/#settings/Usage). [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Verification and submission evidence

```powershell
npm test
node --check src/chatgpt-plan.js
```

The **86-test local suite passes**. Provider tests use a locally generated RSA key, synthetic signed ID tokens, a real loopback callback, injected provider responses and temporary credential storage. They verify PKCE/state/identity checks, permission denial, account-specific model selection, detailed catalogs above the prior response cap, model-field whitelisting/order, cancellation above 1 MiB, the 500-entry bound, incomplete streams, missing model identity, actual provenance, ordinary unexpected/non-OK body cancellation without reads, bounded diagnostics and malicious-header redaction, missing-MIME rejection even for a synthetic completed SSE body, early cancellation of malformed SSE events/completion metadata, attempt limits, rotating tokens, stale renewal, cancellation during persistence, revocation failure and Windows ownership/DACL behavior. New memory-only diagnostic fixtures verify trace-ID retention and status-copy isolation, exactly enumerated JSON error metadata, missing-MIME refusal despite an SSE-like prefix, the total 4 KiB BYOB read cap, unread refusal of ordinary readers, fixed shape categories, malformed UTF-8, bounded stalled reads/cancellation and sanitized transport failures. These tests perform no account or inference calls.

`node src/chatgpt-plan.js` is a safe preparation diagnostic: it initializes protected app metadata and prints sanitized connection status, then releases the lock. It does not start sign-in or perform inference. Close the running ScopeGuard server before using it, since the connection is single-owner.

Status distinguishes preparation (`configured` on the connection), validated identity (`connected`), granted plan permission (`sharing`), selected account model, dispatched attempt count and accepted inference count. The assistant’s `configured` getter requires sharing permission plus a selected model. `verifiedInferenceCalls` begins at zero for every process and increases only after a completed, validated assessment. `lastVerifiedInference` retains the actual request/response provenance without credentials. Synthetic tests and public discovery never increase the real application’s inference count.

Before claiming meaningful live AI use in a hackathon submission, retain a sanitized successful assessment showing its requested model, returned model, completed-response ID and grounded scope evidence. Actual owner consent, initial connection and account-returned catalog access have been observed, but the two refused requests do not establish successful model inference, output quality or live token-renewal behavior. Verify the sponsor's separate PayPal sandbox requirements through the project's main README. This provider does not satisfy payment integration evidence by itself. The [public source repository](https://github.com/Vcode2407/paypal-scopeguard) is available. Accepted runtime AI and PayPal evidence remain pending.

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
