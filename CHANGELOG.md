# @blockchain0x/x402 changelog

## [0.1.0-alpha.4] - 2026-06-11

Buyer-side spend guardrails (security sub-plan 27.1 row A6). The 402
challenge is attacker-controlled input; the client now lets callers bound
what it will pay:

- `maxAmountWei` on `createX402Client` - a quote above the ceiling throws
  `X402ClientError('amount_over_cap')` BEFORE any payment is created.
  Callers SHOULD always set this.
- `allowedPayTo` - optional recipient allowlist; a quote outside it throws
  `X402ClientError('recipient_not_allowed')`.
- The requirement's `maxAgeSeconds` is now enforced: a confirmation that
  lands after the window throws `X402ClientError('stale_challenge')`.
- Behavior change: when the SDK's network cannot be derived (unknown key
  prefix, no explicit `network`), the client now throws
  `X402ClientError('no_matching_requirement')` instead of silently paying
  the first listed requirement (`accepts[0]`).

## [0.1.0-alpha.3] - 2026-05-29

minor

## [0.1.0-alpha.2] - 2026-05-29

minor

## [0.1.0-alpha.1] - 2026-05-29

minor update

## 0.1.0-alpha.0

First publish (sub-plan 21.2 rows B-1..B-5).

Adds:

- Wire-format primitives: `parse402Response`, `buildPaymentHeader`, `parsePaymentHeader` + `X402WireError` (`@blockchain0x/x402`).
- Client wrapper: `createX402Client({ sdk })` returns a `fetch`-compatible function that auto-pays on 402, polls for confirmation, and retries with `X-Payment` (`@blockchain0x/x402/client`).
- Fastify plugin: `createX402Plugin` gates routes behind a USDC quote, calls `sdk.paymentRequests.settle` to verify, stamps `req.x402Payment` (`@blockchain0x/x402/server/fastify`).
- Express middleware: `createX402Middleware` ditto for Express (`@blockchain0x/x402/server/express`).

Peer dependency: `@blockchain0x/node@^0.2.0`.

[0.1.0-alpha.3]: https://github.com/Tosh-Labs/blockchain0x-x402/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Tosh-Labs/blockchain0x-x402/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Tosh-Labs/blockchain0x-x402/releases/tag/v0.1.0-alpha.1
