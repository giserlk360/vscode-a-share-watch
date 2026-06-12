// Feature: vscode-stock-monitor, Property 10: 缓存回退正确性

/**
 * 属性测试：缓存回退正确性
 * Validates: Requirements 6.6
 *
 * 属性描述：
 * 对于任意已缓存的股票数据，当网络请求失败时，fetchBatch() 返回的数据
 * 应与缓存中存储的最后一次有效数据完全一致。
 *
 * 测试策略：
 * 1. 先通过 provider.setCache() 注入缓存数据
 * 2. mock _fetchFromEastMoney 和 _fetchFromSina 均抛出错误（模拟网络失败）
 * 3. 调用 fetchBatch()，验证返回数据与注入的缓存数据完全一致
 */

import * as fc from 'fast-check';
import { StockDataProvider } from '../../data/StockDataProvider';
import { StockData, CacheEntry } from '../../types';

// ─── 代码生成器 ───────────────────────────────────────────────────────────────

/** 生成合法的带前缀股票代码，如 sh600036 / sz000001 */
const stockCodeArb: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('sh', 'sz'),
  fc.stringOf(
    fc.char().filter((c) => c >= '0' && c <= '9'),
    { minLength: 6, maxLength: 6 }
  )
).map(([prefix, digits]) => `${prefix}${digits}`);

/** 生成合法的股票价格（0.01 ~ 9999.99） */
const priceArb: fc.Arbitrary<number> = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(9999.99),
  noNaN: true,
});

/** 根据代码生成一条 StockData */
function stockDataArb(code: string): fc.Arbitrary<StockData> {
  return fc.record({
    code: fc.constant(code),
    name: fc.string({ minLength: 1, maxLength: 10 }),
    currentPrice: priceArb,
    openPrice: priceArb,
    closePrice: priceArb,
    changeAmount: fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }),
    changeRate: fc.float({ min: Math.fround(-20), max: Math.fround(20), noNaN: true }),
    volume: fc.nat({ max: 10_000_000 }),
    isETF: fc.boolean(),
    timestamp: fc.nat({ max: Date.now() }),
  });
}

/** 生成非空的 (code, StockData) 对列表（1~5 条，去重） */
const cachedEntriesArb: fc.Arbitrary<Array<{ code: string; data: StockData }>> = fc
  .array(stockCodeArb, { minLength: 1, maxLength: 5 })
  .map((codes) => Array.from(new Set(codes)))
  .filter((codes) => codes.length >= 1)
  .chain((codes) =>
    fc.tuple(...codes.map((code) => stockDataArb(code).map((data) => ({ code, data }))))
      .map((entries) => Array.from(entries))
  );

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 10: 缓存回退正确性', () => {

  test('网络全部失败时，fetchBatch 返回数据与缓存完全一致', async () => {
    await fc.assert(
      fc.asyncProperty(cachedEntriesArb, async (entries) => {
        const provider = new StockDataProvider();

        // 1. 注入缓存数据
        for (const { code, data } of entries) {
          const cacheEntry: CacheEntry = { data, fetchedAt: Date.now() };
          provider.setCache(code, cacheEntry);
        }

        // 2. mock 两个数据源均抛出错误
        (provider as any)._fetchFromEastMoney = jest.fn().mockRejectedValue(
          new Error('模拟东方财富网络失败')
        );
        (provider as any)._fetchFromSina = jest.fn().mockRejectedValue(
          new Error('模拟新浪网络失败')
        );

        // 3. 调用 fetchBatch，期望回退到缓存
        const codes = entries.map((e) => e.code);
        const results = await provider.fetchBatch(codes);

        // 4. 验证返回数据与缓存完全一致
        expect(results.length).toBe(entries.length);

        for (const { code, data: cachedData } of entries) {
          const result = results.find((r) => r.code === code);
          expect(result).toBeDefined();
          expect(result).toEqual(cachedData);
        }
      }),
      { numRuns: 100 }
    );
  });

  test('网络全部失败时，无缓存的代码不出现在返回结果中', async () => {
    await fc.assert(
      fc.asyncProperty(cachedEntriesArb, async (entries) => {
        const provider = new StockDataProvider();

        // 只注入部分缓存（取前半段）
        const cachedEntries = entries.slice(0, Math.ceil(entries.length / 2));
        for (const { code, data } of cachedEntries) {
          provider.setCache(code, { data, fetchedAt: Date.now() });
        }

        (provider as any)._fetchFromEastMoney = jest.fn().mockRejectedValue(
          new Error('模拟东方财富网络失败')
        );
        (provider as any)._fetchFromSina = jest.fn().mockRejectedValue(
          new Error('模拟新浪网络失败')
        );

        // 请求所有代码（包含有缓存和无缓存的）
        const codes = entries.map((e) => e.code);
        const results = await provider.fetchBatch(codes);

        // 结果数量应等于有缓存的条目数
        expect(results.length).toBe(cachedEntries.length);

        // 结果中每条数据都应来自缓存
        const cachedCodes = new Set(cachedEntries.map((e) => e.code));
        for (const result of results) {
          expect(cachedCodes.has(result.code)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

});
