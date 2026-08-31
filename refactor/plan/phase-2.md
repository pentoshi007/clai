# Phase 2 — LLM transport and routing

Status: **planned**
Depends on: Phase 1 complete
Primary hotspots: `src/llm/http.ts` (2,646 lines), `src/llm/router.ts` (1,868 lines)

## Objective

Separate request construction, provider dialects, stream decoding, terminal semantics, error policy, retries, key/endpoint rotation, and provider routing behind stable public facades. Preserve exact wire behavior and failure/recovery semantics for all providers.

The audit also identifies `buildReasoningPayload`, `openAiCompatibleStream`, and `validateCustomProviderProfile` as major complexity seams. Raw `unknown` is concentrated in LLM decoding modules; boundary values must remain unknown until validated rather than being cast away.

## Scope

In scope:

- `src/llm/http.ts`, `src/llm/router.ts`;
- reasoning/sampling/request/stream/error helpers currently coupled to those files;
- `src/llm/custom-provider-profile.ts` and closely related profile/catalog decoders where required to remove complexity;
- existing response-stream, merge-gateway, adapter, capability, rotation, and provider modules when a directional seam requires migration;
- `test/conformance`, `test/admission/router-admissions.test.ts`, `test/llm`, `test/profiles`, provider wire/model tests, and request snapshots.

Out of scope:

- changing provider defaults, model catalogs, prices, credentials, fallback policy, timeouts, or supported API dialects;
- updating snapshots to a preferred payload;
- tool registry implementation (Phase 3);
- UI provider pickers (Phase 6);
- broad provider feature work.

## Protected wire and routing contracts

Characterization must cover:

- URL/path selection, query parameters, method, headers, auth, user agent, and provider-specific credentials;
- exact JSON keys, nesting, ordering where snapshots observe it, omission versus `null`, defaults, numeric bounds, and schema sanitation;
- system/developer/user/tool message mapping, images, tool definitions/choice, prompt caching, response format, sampling, and reasoning controls;
- OpenAI-compatible, Responses-style, Anthropic, Gemini, Ollama, free-gateway, custom, and provider-specific dialect behavior;
- SSE framing across arbitrary chunk boundaries, JSON event validation, thinking/content/tool delta ordering, multi-tool assembly, usage-only chunks, in-band errors, EOF, abort, empty completion, and terminal event exactly once;
- token/cache/reasoning usage aggregation and replay artifacts;
- error class, status, message, retryability, user-facing masking, and diagnostic detail;
- retry counts, backoff/jitter bounds, reasoning-option degradation, stream-option retry, transient handling, and abort responsiveness;
- key and endpoint precedence, disabled entries, circular rotation, sticky success, immediate auth/quota switching, provider fallback, free-only filtering, and model/provider pairing;
- no credential forwarding across redirects or provider boundaries;
- no additional request is emitted by a structural refactor.

## Required characterization

Run the existing contract suites before movement:

```sh
npx vitest run \
  test/conformance \
  test/admission/router-admissions.test.ts \
  test/admission/request-fingerprint.test.ts \
  test/llm \
  test/profiles \
  test/llm-stream-hardening.test.ts \
  test/llm-stream-progress.test.ts \
  test/llm-vision-wire.test.ts \
  test/llm-system-messages.test.ts \
  test/llm-sampling.test.ts \
  test/reasoning-degradation.test.ts \
  test/nvidia-payload.test.ts \
  test/custom-providers.test.ts \
  test/modal-endpoint-rotation.test.ts \
  test/provider-model-pairing.test.ts \
  test/single-key-fallback-gate.test.ts \
  --reporter=dot
```

Add missing fixtures for malformed/truncated events, boundary chunking, every terminal path, retries that must not duplicate content/tools, and credential isolation. Preserve fixture bytes and review snapshot diffs manually.

## Intended module boundaries

Use existing modules when they already own a concern; do not create parallel implementations. Expected boundaries are:

1. **Request plan/domain** — validated, provider-neutral inputs and an explicit request plan.
2. **Dialect payload builders** — pure builders per protocol/provider family with exact snapshot coverage.
3. **Header/auth builders** — provider-specific credentials and headers, with redacted diagnostics.
4. **Reasoning and sampling policy** — capability-aware payload decisions separated from transport.
5. **Stream transport** — fetch/abort/timeout mechanics only.
6. **SSE/event decoder** — byte/text framing and validated protocol events.
7. **Stream accumulator/terminal state** — ordered content/thinking/tool/usage assembly and exactly-once completion.
8. **Error normalization/classification** — typed errors and retry/fallback reasons without scheduling retries.
9. **Retry/rotation coordinator** — attempt ledger, backoff, key/endpoint selection, sticky updates, and provider fallback.
10. **Router facade** — stable public entrypoints that compose selection and transport.
11. **Profile/catalog decoders** — boundary `unknown` to validated domain types with path-specific diagnostics.

Dependencies flow from router/orchestrator to plans, policies, builders, transport, decoders, and stores through narrow ports. Stream parsers must not import routing policy; payload builders must not read mutable key stores.

## Work sequence

### 1. Freeze requests and terminals

Capture representative request fingerprints for every dialect/capability combination and terminal traces for success, tool calls, usage-only EOF, malformed input, abort, timeout, empty response, and in-band error.

### 2. Extract pure payload policy

Move reasoning/sampling and payload builders one dialect at a time. Keep old exports as facades. Do not normalize payload shape or combine provider branches simply because they look similar.

### 3. Extract stream framing and decoding

Separate raw SSE framing from event validation, then separate event accumulation. Test every possible chunk split and ensure malformed untrusted events remain safely narrowed.

### 4. Extract terminal/error semantics

Model terminal states explicitly and preserve exactly-once callbacks/results. Move error normalization separately from retry decisions so wire errors can be tested without the router.

### 5. Extract retries and rotation

Move attempt state, degradation retries, key/endpoint rotation, sticky updates, and cross-provider fallback in small commits. Compare operation ledgers and request counts.

### 6. Decompose profile validation

Replace high-complexity branching with focused decoders/predicates and discriminated results. Keep `unknown` at JSON/custom-provider boundaries and remove unsafe assertions.

### 7. Reduce facades

Migrate callers mechanically. Remove `src/llm/http.ts` and `src/llm/router.ts` from the frozen oversized baseline as each reaches 1,000 lines or fewer, then continue until both and all extracted ordinary files are under 500.

## Acceptance criteria

- [ ] Request fingerprints and reviewed snapshots are byte/structure equivalent for every supported dialect.
- [ ] Stream event order, terminal behavior, usage, errors, aborts, retries, and request counts are unchanged.
- [ ] Key/endpoint/provider rotation and sticky state are unchanged under all classified failures.
- [ ] Credentials remain redacted and isolated from redirects/fallbacks.
- [ ] Boundary payloads are validated; no new unsafe cast, `any`, or suppression is introduced.
- [ ] `http.ts`, `router.ts`, and all changed ordinary files are `<500`; legacy entries are removed without additions.
- [ ] Changed functions meet complexity/Halstead/CRAP ratchets and have no surviving scoped mutants.
- [ ] Conformance, admission, LLM, profile, architecture, full-suite, and build checks pass.

## Validation

The `test:deterministic` and `quality:*` scripts below are Phase 0 deliverables and must exist before this phase begins; use the final names recorded by Phase 0.

After each wire/stream seam:

```sh
npm run typecheck
npm run test:conformance -- --reporter=dot
npm run test:admission -- --reporter=dot
npx vitest run test/llm test/profiles --reporter=dot
npm run quality:changed
```

At phase close:

```sh
npm run typecheck
npm run embed-prompts:check
npm run test:arch -- --reporter=dot
npm run test:conformance -- --reporter=dot
npm run test:admission -- --reporter=dot
npx vitest run test/llm test/profiles --reporter=dot
npm run test:deterministic -- --reporter=dot
npm run build
npm run quality:ratchet
npm run quality:mutation -- --scope llm
npm run release:verify
git diff --check
```

The standalone conformance/admission commands are explicit local checks; the repository's full `npm test` also contains these suites.

## Commit and rollback plan

Use separate commits for request builders, stream framing, event decoding, terminal/error mapping, retry/rotation, and profile decoding. Never mix a snapshot rewrite or provider behavior fix with extraction. Keep stable facade exports until callers are migrated. If a request fingerprint, operation ledger, or stream terminal trace changes unexpectedly, revert that seam and retain any valid new characterization fixture.
