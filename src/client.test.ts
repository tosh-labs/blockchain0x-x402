/**
 * Unit tests for createX402Client (sub-plan 27.1 row A6).
 *
 * The 402 challenge is attacker-controlled input; these tests pin the
 * buyer-side guardrails: maxAmountWei over-cap rejection, allowedPayTo,
 * maxAgeSeconds (stale challenge), unknown-network refusal (no accepts[0]
 * fallback), and the happy path within policy.
 */

import { describe, expect, it, vi } from 'vitest';
import { createX402Client, type X402SdkLike } from './client.js';
import type { PaymentRequirement } from './types.js';

const PAYEE = '0x' + 'cd'.repeat(20);
const OTHER_PAYEE = '0x' + 'ee'.repeat(20);
const TX = '0x' + '11'.repeat(32);
const PAYER = '0x' + 'ab'.repeat(20);

function requirement(over: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: 'exact-usdc',
    network: 'testnet',
    chainId: 'eip155:84532',
    payToAddress: PAYEE,
    amountWeiUsdc: '1000000',
    paymentRequestId: 'pr_1',
    ...over,
  };
}

function fetch402Then200(accepts: PaymentRequirement[]): {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ headers: Headers }>;
} {
  const calls: Array<{ headers: Headers }> = [];
  let n = 0;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers ?? undefined) });
    n += 1;
    if (n === 1) {
      return new Response(JSON.stringify({ version: 1, resource: '/paid', accepts }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function mockSdk(over: Partial<{ apiKey: string }> = {}): {
  sdk: X402SdkLike;
  paymentsCreate: ReturnType<typeof vi.fn>;
} {
  const paymentsCreate = vi.fn(async () => ({
    id: 'pay_1',
    agentId: 'agt_1',
    status: 'submitted',
  }));
  const sdk: X402SdkLike = {
    options: { apiKey: over.apiKey ?? 'sk_test_abc' },
    payments: { create: paymentsCreate as never },
    transactions: {
      get: async () => ({
        id: 'pay_1',
        status: 'confirmed' as const,
        txHash: TX,
        fromAddress: PAYER,
      }),
    },
  };
  return { sdk, paymentsCreate };
}

describe('27.1.A6 buyer-side guardrails', () => {
  it('rejects an over-cap quote BEFORE any payment is created', async () => {
    const { sdk, paymentsCreate } = mockSdk();
    const { fetchImpl } = fetch402Then200([requirement({ amountWeiUsdc: '2000001' })]);
    const fetch = createX402Client({ sdk, fetch: fetchImpl, maxAmountWei: '2000000' });

    await expect(fetch('https://seller.example/paid')).rejects.toMatchObject({
      name: 'X402ClientError',
      code: 'amount_over_cap',
    });
    expect(paymentsCreate).not.toHaveBeenCalled();
  });

  it('an exactly-at-cap quote is allowed', async () => {
    const { sdk } = mockSdk();
    const { fetchImpl } = fetch402Then200([requirement({ amountWeiUsdc: '2000000' })]);
    const fetch = createX402Client({ sdk, fetch: fetchImpl, maxAmountWei: '2000000' });

    const res = await fetch('https://seller.example/paid');
    expect(res.status).toBe(200);
  });

  it('rejects a recipient outside allowedPayTo before any payment (case-insensitive)', async () => {
    const { sdk, paymentsCreate } = mockSdk();
    const { fetchImpl } = fetch402Then200([requirement({ payToAddress: OTHER_PAYEE })]);
    const fetch = createX402Client({
      sdk,
      fetch: fetchImpl,
      maxAmountWei: '2000000',
      allowedPayTo: [PAYEE.toUpperCase().replace('0X', '0x')],
    });

    await expect(fetch('https://seller.example/paid')).rejects.toMatchObject({
      code: 'recipient_not_allowed',
    });
    expect(paymentsCreate).not.toHaveBeenCalled();
  });

  it('refuses a stale challenge: confirmation landed after maxAgeSeconds', async () => {
    const { sdk } = mockSdk();
    const { fetchImpl } = fetch402Then200([requirement({ maxAgeSeconds: 60 })]);
    let t = 1_000_000;
    const fetch = createX402Client({
      sdk,
      fetch: fetchImpl,
      maxAmountWei: '2000000',
      now: () => {
        // First call stamps the challenge; later calls (post-confirmation)
        // land 61s later.
        const v = t;
        t += 61_000;
        return v;
      },
    });

    await expect(fetch('https://seller.example/paid')).rejects.toMatchObject({
      code: 'stale_challenge',
    });
  });

  it('refuses when the SDK network is unknown instead of falling back to accepts[0]', async () => {
    const { sdk, paymentsCreate } = mockSdk({ apiKey: 'weird_prefix_key' });
    const { fetchImpl } = fetch402Then200([requirement()]);
    const fetch = createX402Client({ sdk, fetch: fetchImpl, maxAmountWei: '2000000' });

    await expect(fetch('https://seller.example/paid')).rejects.toMatchObject({
      code: 'no_matching_requirement',
    });
    expect(paymentsCreate).not.toHaveBeenCalled();
  });

  it('refuses when no requirement matches the key network', async () => {
    const { sdk } = mockSdk({ apiKey: 'sk_live_abc' });
    const { fetchImpl } = fetch402Then200([requirement({ network: 'testnet' })]);
    const fetch = createX402Client({ sdk, fetch: fetchImpl, maxAmountWei: '2000000' });

    await expect(fetch('https://seller.example/paid')).rejects.toMatchObject({
      code: 'no_matching_requirement',
    });
  });

  it('happy path within policy: pays, attaches X-Payment, returns the 200', async () => {
    const { sdk, paymentsCreate } = mockSdk();
    const { fetchImpl, calls } = fetch402Then200([requirement()]);
    const fetch = createX402Client({
      sdk,
      fetch: fetchImpl,
      maxAmountWei: '2000000',
      allowedPayTo: [PAYEE],
    });

    const res = await fetch('https://seller.example/paid');
    expect(res.status).toBe(200);
    expect(paymentsCreate).toHaveBeenCalledWith({
      agentId: '',
      to: PAYEE,
      amountWei: '1000000',
    });
    expect(calls[1]!.headers.get('X-Payment')).toMatch(/^exact-usdc:/);
  });
});
