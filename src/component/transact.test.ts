import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {api, internal} from './_generated/api.js';
import {expectFail, initConvexTest} from './setup.test.js';

const ISSUER = 'https://acme.kinde.com';
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const AGREEMENTS_URL = `${ISSUER}/api/v1/billing/agreements`;

type ConvexTest = ReturnType<typeof initConvexTest>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
}

function mockFetch(
  routes: (url: string, init: RequestInit | undefined) => Response | undefined
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, init});
      const override = routes(url, init);
      if (override !== undefined) {
        return override;
      }
      if (url === TOKEN_URL) {
        return jsonResponse({access_token: 'tok-123', expires_in: 3600});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
  return calls;
}

function stubEnv(): void {
  vi.stubEnv('MANDATE_SIGNING_SECRET', 'test-mandate-secret');
  vi.stubEnv('KINDE_ISSUER_URL', ISSUER);
  vi.stubEnv('KINDE_M2M_CLIENT_ID', 'client-id');
  vi.stubEnv('KINDE_M2M_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('MODE', 'live');
}

async function mapCustomer(t: ConvexTest): Promise<void> {
  await t.mutation(api.kinde.setCustomerMapping, {
    principalType: 'org',
    principalId: 'org_acme',
    customerId: 'cust-1',
    customerAgreementId: 'agr-1'
  });
}

async function auditEvents(t: ConvexTest, eventType: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query('auditLog')
      .withIndex('by_event_type', (q) => q.eq('eventType', eventType))
      .collect()
  );
}

describe('transact', () => {
  beforeEach(() => {
    stubEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('no policy: plan_change is created approved, executes via changePlan', async () => {
    const calls = mockFetch((url) =>
      url === AGREEMENTS_URL ? jsonResponse({id: 'agr-2'}) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);

    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });
    const created = await t.query(api.transact.get, {transactionId: txId});
    expect(created?.status).toBe('approved');

    const result = await t.action(api.transact.execute, {transactionId: txId});
    expect(result.status).toBe('executed');

    const executed = await t.query(api.transact.get, {transactionId: txId});
    expect(executed?.status).toBe('executed');
    expect(executed?.executedAt).not.toBeNull();
    expect(calls.some((c) => c.url === AGREEMENTS_URL)).toBe(true);
    expect(await auditEvents(t, 'transaction.requested')).toHaveLength(1);
    expect(await auditEvents(t, 'transaction.executed')).toHaveLength(1);
  });

  test('requireApproval: pending until approved; execute before approval fails', async () => {
    const calls = mockFetch((url) =>
      url === AGREEMENTS_URL ? jsonResponse({id: 'agr-2'}) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);
    await t.mutation(api.transact.setPolicy, {
      principalType: 'org',
      principalId: 'org_acme',
      requireApproval: true
    });

    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });
    expect(
      (await t.query(api.transact.get, {transactionId: txId}))?.status
    ).toBe('pending');

    await expectFail(
      t.action(api.transact.execute, {transactionId: txId}),
      'not_approved'
    );

    await t.mutation(api.transact.approve, {
      transactionId: txId,
      approverSubject: 'admin_1'
    });
    expect(
      (await t.query(api.transact.get, {transactionId: txId}))?.status
    ).toBe('approved');

    const result = await t.action(api.transact.execute, {transactionId: txId});
    expect(result.status).toBe('executed');
    expect(calls.some((c) => c.url === AGREEMENTS_URL)).toBe(true);
  });

  test('reject: a pending tx becomes rejected and cannot execute', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await t.mutation(api.transact.setPolicy, {
      principalType: 'org',
      principalId: 'org_acme',
      requireApproval: true
    });
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 10
    });
    await t.mutation(api.transact.reject, {
      transactionId: txId,
      approverSubject: 'admin_1'
    });
    expect(
      (await t.query(api.transact.get, {transactionId: txId}))?.status
    ).toBe('rejected');
    await expectFail(
      t.action(api.transact.execute, {transactionId: txId}),
      'not_approved'
    );
  });

  test('approve/reject require a non-empty approver and are pending-only', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await t.mutation(api.transact.setPolicy, {
      principalType: 'org',
      principalId: 'org_acme',
      requireApproval: true
    });
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 10
    });
    await expectFail(
      t.mutation(api.transact.approve, {
        transactionId: txId,
        approverSubject: ''
      }),
      'approver_required'
    );
    await t.mutation(api.transact.approve, {
      transactionId: txId,
      approverSubject: 'admin_1'
    });
    // Re-resolving a non-pending tx fails (idempotency by rejection).
    await expectFail(
      t.mutation(api.transact.approve, {
        transactionId: txId,
        approverSubject: 'admin_1'
      }),
      'already_resolved'
    );
    await expectFail(
      t.mutation(api.transact.reject, {
        transactionId: txId,
        approverSubject: 'admin_1'
      }),
      'already_resolved'
    );
  });

  test('caps are enforced at request time and write no tx row', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await t.mutation(api.transact.setPolicy, {
      principalType: 'org',
      principalId: 'org_acme',
      perTxCap: 100,
      perPeriodCap: 150,
      requireApproval: false
    });

    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'credit',
        amount: 101
      }),
      'per_tx_cap_exceeded'
    );

    // First 90 is fine; a second 90 would breach the 150 period cap.
    await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 90
    });
    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'credit',
        amount: 90
      }),
      'per_period_cap_exceeded'
    );

    const rows = await t.query(api.transact.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme'
    });
    expect(rows).toHaveLength(1);
  });

  test('contradictory args are rejected, not coerced', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'plan_change'
      }),
      'plan_change_requires_plan_code'
    );
    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'plan_change',
        planCode: 'pro',
        amount: 5
      }),
      'plan_change_amount_not_allowed'
    );
    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'credit'
      }),
      'amount_required'
    );
    await expectFail(
      t.mutation(api.transact.request, {
        principalType: 'org',
        principalId: 'org_acme',
        type: 'credit',
        amount: 5,
        planCode: 'pro'
      }),
      'plan_code_not_allowed'
    );
  });

  test('execute Kinde failure flips the tx to failed with a reason', async () => {
    mockFetch((url) =>
      url === AGREEMENTS_URL ? jsonResponse({error: 'nope'}, 503) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });

    const result = await t.action(api.transact.execute, {transactionId: txId});
    expect(result.status).toBe('failed');

    const failed = await t.query(api.transact.get, {transactionId: txId});
    expect(failed?.status).toBe('failed');
    expect(failed?.failureReason).toBeTruthy();
    expect(failed?.executedAt).toBeNull();
    expect(await auditEvents(t, 'transaction.failed')).toHaveLength(1);
  });

  test('credit executes locally with no Kinde call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = initConvexTest();
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 25
    });
    const result = await t.action(api.transact.execute, {transactionId: txId});
    expect(result.status).toBe('executed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('refund: only an executed tx compensates; idempotent; non-executed fails', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 25
    });

    // Not executed yet -> cannot compensate.
    await expectFail(
      t.mutation(api.transact.refund, {transactionId: txId, reason: 'early'}),
      'not_executed'
    );

    await t.action(api.transact.execute, {transactionId: txId});
    await t.mutation(api.transact.refund, {
      transactionId: txId,
      reason: 'oops'
    });

    const compensated = await t.query(api.transact.get, {transactionId: txId});
    expect(compensated?.status).toBe('compensated');
    expect(compensated?.compensatedAt).not.toBeNull();
    const audit = await auditEvents(t, 'transaction.compensated');
    expect(audit).toHaveLength(1);
    expect(audit[0].detail.reversedAmount).toBe(25);

    // A second refund is a no-op (no new audit row, status unchanged).
    await t.mutation(api.transact.refund, {
      transactionId: txId,
      reason: 'again'
    });
    expect(
      (await t.query(api.transact.get, {transactionId: txId}))?.status
    ).toBe('compensated');
    expect(await auditEvents(t, 'transaction.compensated')).toHaveLength(1);
  });

  test('setPolicy hardening: negative cap and inconsistent period are rejected', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.transact.setPolicy, {
        principalType: 'org',
        principalId: 'org_acme',
        perTxCap: -1,
        requireApproval: false
      }),
      'invalid_cap'
    );
    await expectFail(
      t.mutation(api.transact.setPolicy, {
        principalType: 'org',
        principalId: 'org_acme',
        periodStart: 100,
        periodEnd: 100,
        requireApproval: false
      }),
      'invalid_period'
    );
  });

  test('list and get scope to the principal and respect the status filter', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    const a = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'credit',
      amount: 5
    });
    await t.mutation(api.transact.request, {
      principalType: 'user',
      principalId: 'user_bob',
      type: 'credit',
      amount: 5
    });

    const forOrg = await t.query(api.transact.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme'
    });
    expect(forOrg).toHaveLength(1);
    expect(forOrg[0]._id).toBe(a);

    const approvedOnly = await t.query(api.transact.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme',
      status: 'approved'
    });
    expect(approvedOnly).toHaveLength(1);
    const rejectedOnly = await t.query(api.transact.listForPrincipal, {
      principalType: 'org',
      principalId: 'org_acme',
      status: 'rejected'
    });
    expect(rejectedOnly).toHaveLength(0);
  });

  test('claim is the concurrency guard: a second claim on an executing tx does not re-enter', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    await mapCustomer(t);
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });

    const first = await t.mutation(internal.transact.claim, {
      transactionId: txId
    });
    expect(first).toEqual({claimed: true, status: 'executing'});

    // A second claim observes 'executing' and does not re-enter.
    const second = await t.mutation(internal.transact.claim, {
      transactionId: txId
    });
    expect(second.claimed).toBe(false);
    expect(second.status).toBe('executing');
  });

  test('a duplicate execute does not submit a second Kinde plan change', async () => {
    const calls = mockFetch((url) =>
      url === AGREEMENTS_URL ? jsonResponse({id: 'agr-2'}) : undefined
    );
    const t = initConvexTest();
    await mapCustomer(t);
    const txId = await t.mutation(api.transact.request, {
      principalType: 'org',
      principalId: 'org_acme',
      type: 'plan_change',
      planCode: 'pro'
    });

    const first = await t.action(api.transact.execute, {transactionId: txId});
    expect(first.status).toBe('executed');
    const agreementsCalls = () =>
      calls.filter((c) => c.url === AGREEMENTS_URL).length;
    expect(agreementsCalls()).toBe(1);

    // A second execute on the now-executed tx must not call Kinde again.
    await expectFail(
      t.action(api.transact.execute, {transactionId: txId}),
      'not_approved'
    );
    expect(agreementsCalls()).toBe(1);
  });

  test('setPolicy: a period window without a positive periodLengthMs is rejected', async () => {
    mockFetch(() => undefined);
    const t = initConvexTest();
    // Valid window (end > start) but no periodLengthMs.
    await expectFail(
      t.mutation(api.transact.setPolicy, {
        principalType: 'org',
        principalId: 'org_acme',
        perPeriodCap: 100,
        periodStart: 0,
        periodEnd: 1000,
        requireApproval: false
      }),
      'invalid_period'
    );
    // Zero periodLengthMs.
    await expectFail(
      t.mutation(api.transact.setPolicy, {
        principalType: 'org',
        principalId: 'org_acme',
        perPeriodCap: 100,
        periodStart: 0,
        periodEnd: 1000,
        periodLengthMs: 0,
        requireApproval: false
      }),
      'invalid_period'
    );
    // Negative periodLengthMs.
    await expectFail(
      t.mutation(api.transact.setPolicy, {
        principalType: 'org',
        principalId: 'org_acme',
        perPeriodCap: 100,
        periodStart: 0,
        periodEnd: 1000,
        periodLengthMs: -5,
        requireApproval: false
      }),
      'invalid_period'
    );
  });
});
