# @blockchain0x/x402

[x402 protocol](https://github.com/coinbase/x402) client + server adapters for autonomous AI agents on Base + USDC. Pairs with [`@blockchain0x/node`](https://www.npmjs.com/package/@blockchain0x/node) to give your agent two drop-in pieces:

- A `fetch`-compatible **client wrapper** that transparently handles HTTP 402 - it pays the requirement, polls for on-chain confirmation, and retries the original request with the `X-Payment` header.
- **Server adapters** (Fastify plugin + Express middleware) that gate routes behind a USDC quote - the backend's `paymentRequests.settle` route is the trust anchor, the adapter is a thin verification shim.

Status: alpha. Wire format follows the Coinbase x402 reference (`X-Payment: <scheme>:<base64-payload>`), constrained to `scheme = exact-usdc` and the two Base networks (mainnet + Sepolia testnet).

## Install

Both packages are currently in alpha; install the `@alpha` tag explicitly so npm picks the matching pre-release pair:

```sh
npm install @blockchain0x/x402@alpha @blockchain0x/node@alpha
```

`@blockchain0x/node` is a hard peer dependency: the client wrapper calls `sdk.payments.create` + `sdk.transactions.get`, and the server adapters call `sdk.paymentRequests.settle`. The peer range pins to `^0.2.0-alpha.0`, so any `0.2.0-alpha.*` of `@blockchain0x/node` works (plus the eventual `0.2.0` stable release).

## Pay-side: drop-in fetch wrapper

```ts
import { createClient } from '@blockchain0x/node';
import { createX402Client } from '@blockchain0x/x402/client';

const sdk = createClient({ apiKey: process.env.B0X_API_KEY! }); // sk_test_... or sk_live_...
const fetch = createX402Client({
  sdk,
  // ALWAYS set a spend ceiling (6-dp USDC base units). The 402 quote is
  // attacker-controlled input; without a cap the wrapper would pay
  // whatever the seller quotes, bounded only by the on-chain allowance.
  maxAmountWei: '500000', // 0.50 USDC
});

const res = await fetch('https://service-b.com/llm-query', {
  method: 'POST',
  body: JSON.stringify({ q: 'what is the airspeed velocity...' }),
  headers: { 'content-type': 'application/json' },
});
// status 200, body whatever service-b returned. The 402 + pay + confirm
// + retry round-trip happened transparently.
const result = await res.json();
```

What the wrapper does on a 402:

1. Parse the response with `parse402Response`.
2. Pick the requirement whose `network` matches the SDK's bound key mode (sk*test*_ -> testnet, sk*live*_ -> mainnet). An unknown key mode is a refusal (`no_matching_requirement`), never a guess.
3. Enforce the spend policy BEFORE paying: a quote above `maxAmountWei` throws `X402ClientError('amount_over_cap')`; a pay-to address outside `allowedPayTo` (when set) throws `X402ClientError('recipient_not_allowed')`.
4. Call `sdk.payments.create({ agentId, to, amountWei })`. The SDK auto-attaches an `Idempotency-Key` so a flaky retry never double-spends.
5. Poll `sdk.transactions.get(payment.id)` every 1 s up to 30 s until `status === 'confirmed'` + `txHash` is non-null. Timeout - `X402ClientError('settlement_timeout')`.
6. Enforce the requirement's `maxAgeSeconds`: a confirmation that lands after the challenge's validity window throws `X402ClientError('stale_challenge')`.
7. Build the `X-Payment` header with `buildPaymentHeader` and re-issue the original request.

If the second hop also returns 402 the wrapper throws `X402ClientError('second_402')` - the server's verification rejected the proof and looping won't help.

### Spend policy (set this)

The 402 challenge comes from the seller - treat it as untrusted input. `maxAmountWei` is your per-call ceiling; `allowedPayTo` pins the recipients you intend to pay. The on-chain SpendPermission allowance is the LAST line of defense, not the first.

```ts
const fetch = createX402Client({
  sdk,
  maxAmountWei: '500000', // refuse any quote above 0.50 USDC
  allowedPayTo: ['0xSellerAddress...'], // optional recipient pinning
});
```

### Tuning knobs

```ts
const fetch = createX402Client({
  sdk,
  confirmTimeoutSeconds: 60, // default 30
  confirmPollMs: 500, // default 1000
  fetch: customFetch, // default globalThis.fetch
});
```

## Receive-side: server adapters

### Fastify

```ts
import Fastify from 'fastify';
import { createClient } from '@blockchain0x/node';
import { createX402Plugin } from '@blockchain0x/x402/server/fastify';

const app = Fastify();
const sdk = createClient({ apiKey: process.env.B0X_API_KEY! });

await app.register(createX402Plugin, {
  sdk,
  defaultNetwork: 'mainnet',
  pricing: {
    'POST /llm-query': {
      amountUsdc: '0.10',
      payToAddress: '0xYourAgentWalletAddress',
      paymentRequestId: 'pr_static_or_per_resource',
    },
  },
});

app.post('/llm-query', async (req) => {
  // Only reached when X-Payment verified. req.x402Payment carries the
  // proof tuple if you want to log it.
  return { answer: '42', paidBy: req.x402Payment?.payerAddress };
});
```

### Express

```ts
import express from 'express';
import { createClient } from '@blockchain0x/node';
import { createX402Middleware } from '@blockchain0x/x402/server/express';

const app = express();
app.use(express.json());

const sdk = createClient({ apiKey: process.env.B0X_API_KEY! });

app.use(
  createX402Middleware({
    sdk,
    pricing: {
      'POST /llm-query': {
        amountUsdc: '0.10',
        payToAddress: '0xYourAgentWalletAddress',
        paymentRequestId: 'pr_static_or_per_resource',
      },
    },
  })
);

app.post('/llm-query', (req, res) => {
  res.json({ answer: '42', paidBy: req.x402Payment?.payerAddress });
});
```

What the adapter does:

1. Look up `<METHOD> <path>` in the pricing table.
2. **Miss** - call the handler immediately (the route is free).
3. **Hit + no/invalid X-Payment** - return 402 with an `accepts[]` body the payer can parse.
4. **Hit + valid X-Payment** - call `sdk.paymentRequests.settle(...)`. The backend verifies the tuple against the canonical `transactions` table; success flips the invoice to `settled` and the adapter calls the route handler. Failure surfaces as a 402 with `error.reason` set to the rejection cause (`requirement_mismatch`, `settle_rejected`, etc).

## Trust model

The adapter is **not** the trust anchor. It does no on-chain verification of its own. The hard checks live in the Blockchain0x backend's `POST /v1/payment-requests/{id}/settle` route (sub-plan 21.2 row A-3):

- The supplied `txHash` exists in the canonical `transactions` table with `status='confirmed'`.
- The chain's `to_address` matches the invoice's agent wallet.
- The chain's `amount_wei` matches the invoice's expected amount.
- The caller's API-key `agentId` matches the invoice's `agent_wallet_id`.

A failure on any of those returns a 4xx to the adapter AND fires an `invoice.settlement_failed` webhook so the agent's receiver hears the negative outcome.

## Wire-format primitives

If you need the low-level pieces (you are writing a different runtime, or implementing the protocol from scratch):

```ts
import {
  parse402Response,
  buildPaymentHeader,
  parsePaymentHeader,
  X402WireError,
} from '@blockchain0x/x402';
```

- `parse402Response(res)` - consume a 402 `Response` body and return the typed `accepts[]`. Throws `X402WireError('response.*')` on shape problems.
- `buildPaymentHeader(payment)` - encode an `ExactUsdcPayment` as `X-Payment: exact-usdc:<base64>`.
- `parsePaymentHeader(value)` - decode an `X-Payment` header back to a typed payload. Lowercases hex fields so downstream comparisons against the chain are deterministic.

## Error catalog

| Error class       | Code                       | When                                                      |
| ----------------- | -------------------------- | --------------------------------------------------------- |
| `X402WireError`   | `response.not_402`         | Asked to parse a 200/4xx as a 402.                        |
| `X402WireError`   | `response.body_missing`    | 402 body is empty / non-object.                           |
| `X402WireError`   | `response.body_malformed`  | 402 body fails shape validation.                          |
| `X402WireError`   | `header.missing`           | `X-Payment` not present where expected.                   |
| `X402WireError`   | `header.malformed`         | `X-Payment` not `<scheme>:<base64>`.                      |
| `X402WireError`   | `header.unknown_scheme`    | Scheme other than `exact-usdc`.                           |
| `X402WireError`   | `header.payload_malformed` | Base64 or JSON or shape failed.                           |
| `X402ClientError` | `no_matching_requirement`  | 402 lists no requirement matching the key's network.      |
| `X402ClientError` | `settlement_timeout`       | Chain didn't confirm within `confirmTimeoutSeconds`.      |
| `X402ClientError` | `chain_failed`             | `sdk.transactions.get` returned `status='failed'`.        |
| `X402ClientError` | `second_402`               | Server returned 402 even after a valid-looking X-Payment. |

## License

Apache-2.0. See [LICENSE](./LICENSE).
