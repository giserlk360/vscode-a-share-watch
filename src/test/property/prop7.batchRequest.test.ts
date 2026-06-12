// Feature: vscode-stock-monitor, Property 7: 批量请求结果完整性

/**
 * 属性测试：批量请求结果完整性
 * Validates: Requirements 6.9
 *
 * 属性描述：
 * 对于任意非空股票代码列表，网络正常时 fetchBatch(codes) 返回的结果数量应等于
 * 输入代码数量，且每条结果的 code 字段与对应请求代码一致。
 *
 * 测试策略：
 * mock StockDataProvider 的私有方法 _fetchFromEastMoney，注入预设返回数据，
 * 模拟网络正常的情况，避免真实网络依赖。
 */

import * as fc from 'fast-check';
import { StockDataProvider } from '../../data/StockDataProvider';
import { StockData } from '../../types';

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/**
 * 根据股票代码列表构造模拟的 StockData 数组
 * 每条数据的 code 字段与输入代码严格对应
 */
function buildMockStockData(codes: string[]): StockData[] {
  return codes.map((code) => ({
    code,
    name: `股票_${code}`,
    currentPrice: 10.00,
    openPrice: 9.80,
    closePrice: 9.90,
    changeAmount: 0.10,
    changeRate: 1.01,
    volume: 10000,
    isETF: false,
    timestamp: Date.now(),
  }));
}

// ─── 代码生成器 ───────────────────────────────────────────────────────────────

/** 生成合法的带前缀股票代码，如 sh600036 / sz000001 */
const stockCodeArb: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('sh', 'sz'),
  fc.stringOf(
    fc.char().filter((c) => c >= '0' && c <= '9'),
    { minLength: 6, maxLength: 6 }
  )
).map(([prefix, digits]) => `${prefix}${digits}`);

/** 生成非空股票代码列表（1~10 个，去重） */
const nonEmptyCodesArb: fc.Arbitrary<string[]> = fc
  .array(stockCodeArb, { minLength: 1, maxLength: 10 })
  .map((codes) => Array.from(new Set(codes)))
  .filter((codes) => codes.length >= 1);

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 7: 批量请求结果完整性', () => {

  test('网络正常时，fetchBatch 返回结果数量等于输入代码数量', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyCodesArb, async (codes) => {
        const provider = new StockDataProvider();

        // mock 私有方法 _fetchFromEastMoney，注入与 codes 对应的预设数据
        (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue(
          buildMockStockData(codes)
        );

        const results = await provider.fetchBatch(codes);

        expect(results.length).toBe(codes.length);
      }),
      { numRuns: 100 }
    );
  });

  test('网络正常时，fetchBatch 每条结果的 code 字段与请求代码一致', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyCodesArb, async (codes) => {
        const provider = new StockDataProvider();

        (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue(
          buildMockStockData(codes)
        );

        const results = await provider.fetchBatch(codes);

        // 构建结果 code 集合，与输入 codes 集合比较
        const resultCodes = results.map((r) => r.code);
        for (const code of codes) {
          expect(resultCodes).toContain(code);
        }
      }),
      { numRuns: 100 }
    );
  });

});
