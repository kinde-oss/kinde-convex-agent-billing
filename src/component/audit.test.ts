import {describe, expect, test} from 'vitest';
import {api} from './_generated/api.js';
import {initConvexTest} from './setup.test.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

interface SeedRow {
  at: number;
  eventType: string;
  principalType?: 'user' | 'org' | 'agent' | null;
  principalId?: string | null;
  orgCode?: string | null;
}

async function seed(t: ConvexTest, rows: SeedRow[]): Promise<void> {
  await t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert('auditLog', {
        at: row.at,
        eventType: row.eventType,
        principalType: row.principalType ?? null,
        principalId: row.principalId ?? null,
        orgCode: row.orgCode ?? null,
        unit: null,
        decision: null,
        correlationId: `corr-${row.at}`,
        detail: {}
      });
    }
  });
}

async function countAudit(t: ConvexTest): Promise<number> {
  return await t.run(
    async (ctx) => (await ctx.db.query('auditLog').collect()).length
  );
}

const page = {numItems: 100, cursor: null};

describe('audit.query', () => {
  test('no filter returns everything, newest-first', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'a'},
      {at: 300, eventType: 'b'},
      {at: 200, eventType: 'c'}
    ]);
    const result = await t.query(api.audit.query, {paginationOpts: page});
    expect(result.page.map((r) => r.at)).toEqual([300, 200, 100]);
    expect(result.isDone).toBe(true);
  });

  test('principal filter narrows via by_principal', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x', principalType: 'org', principalId: 'org_1'},
      {at: 200, eventType: 'x', principalType: 'org', principalId: 'org_2'},
      {at: 300, eventType: 'x', principalType: 'org', principalId: 'org_1'}
    ]);
    const result = await t.query(api.audit.query, {
      paginationOpts: page,
      principalType: 'org',
      principalId: 'org_1'
    });
    expect(result.page.map((r) => r.at)).toEqual([300, 100]);
    expect(result.page.every((r) => r.principalId === 'org_1')).toBe(true);
  });

  test('orgCode filter narrows via by_org_code', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x', orgCode: 'org_1'},
      {at: 200, eventType: 'x', orgCode: 'org_2'},
      {at: 300, eventType: 'x', orgCode: 'org_1'}
    ]);
    const result = await t.query(api.audit.query, {
      paginationOpts: page,
      orgCode: 'org_1'
    });
    expect(result.page.map((r) => r.at)).toEqual([300, 100]);
  });

  test('eventType filter narrows via by_event_type', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'usage.recorded'},
      {at: 200, eventType: 'billing.decision'},
      {at: 300, eventType: 'usage.recorded'}
    ]);
    const result = await t.query(api.audit.query, {
      paginationOpts: page,
      eventType: 'usage.recorded'
    });
    expect(result.page.map((r) => r.at)).toEqual([300, 100]);
  });

  test('combined filters AND together', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x', orgCode: 'org_1'},
      {at: 150, eventType: 'y', orgCode: 'org_1'},
      {at: 200, eventType: 'x', orgCode: 'org_2'}
    ]);
    const result = await t.query(api.audit.query, {
      paginationOpts: page,
      orgCode: 'org_1',
      eventType: 'x'
    });
    expect(result.page.map((r) => r.at)).toEqual([100]);
  });

  test('time range is inclusive on both ends', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x'},
      {at: 200, eventType: 'x'},
      {at: 300, eventType: 'x'},
      {at: 400, eventType: 'x'}
    ]);
    const result = await t.query(api.audit.query, {
      paginationOpts: page,
      startAt: 200,
      endAt: 300
    });
    expect(result.page.map((r) => r.at)).toEqual([300, 200]);
  });

  test('pagination returns a cursor and the next page continues', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x'},
      {at: 200, eventType: 'x'},
      {at: 300, eventType: 'x'},
      {at: 400, eventType: 'x'},
      {at: 500, eventType: 'x'}
    ]);
    const first = await t.query(api.audit.query, {
      paginationOpts: {numItems: 2, cursor: null}
    });
    expect(first.page.map((r) => r.at)).toEqual([500, 400]);
    expect(first.isDone).toBe(false);
    expect(typeof first.continueCursor).toBe('string');

    const second = await t.query(api.audit.query, {
      paginationOpts: {numItems: 2, cursor: first.continueCursor}
    });
    expect(second.page.map((r) => r.at)).toEqual([300, 200]);
  });

  test('the query performs no writes (read-only)', async () => {
    const t = initConvexTest();
    await seed(t, [
      {at: 100, eventType: 'x'},
      {at: 200, eventType: 'y'}
    ]);
    const before = await countAudit(t);
    await t.query(api.audit.query, {paginationOpts: page});
    await t.query(api.audit.query, {paginationOpts: page, eventType: 'x'});
    expect(await countAudit(t)).toBe(before);
  });

  test('orgCode + eventType filter is applied before pagination and spans pages', async () => {
    const t = initConvexTest();
    // 10 rows in org_1 alternating x/y; the matching 'x' rows (100,300,500,
    // 700,900) are interleaved with non-matching 'y' rows, so a naive
    // paginate-then-filter would underfill pages and lose matches.
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push({
        at: i * 100,
        eventType: i % 2 === 1 ? 'x' : 'y',
        orgCode: 'org_1'
      });
    }
    // A second org with matching eventType that must never leak in.
    rows.push({at: 1050, eventType: 'x', orgCode: 'org_2'});
    await seed(t, rows);

    // Page through with a small page size; the five matching org_1 'x' rows
    // (900,700,500,300,100) span three pages and come back correctly, and the
    // org_2 row never appears.
    const p1 = await t.query(api.audit.query, {
      paginationOpts: {numItems: 2, cursor: null},
      orgCode: 'org_1',
      eventType: 'x'
    });
    expect(p1.page.map((r) => r.at)).toEqual([900, 700]);
    expect(p1.isDone).toBe(false);

    const p2 = await t.query(api.audit.query, {
      paginationOpts: {numItems: 2, cursor: p1.continueCursor},
      orgCode: 'org_1',
      eventType: 'x'
    });
    expect(p2.page.map((r) => r.at)).toEqual([500, 300]);

    const p3 = await t.query(api.audit.query, {
      paginationOpts: {numItems: 2, cursor: p2.continueCursor},
      orgCode: 'org_1',
      eventType: 'x'
    });
    expect(p3.page.map((r) => r.at)).toEqual([100]);
    expect(p3.isDone).toBe(true);
  });
});
