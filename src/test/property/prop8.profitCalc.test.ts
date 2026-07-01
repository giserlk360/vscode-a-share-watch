// Feature: vscode-stock-monitor, Property 8: 盈亏计算正确性

/**
 * 属性测试：盈亏计算正确性
 * Validates: Requirements 6.8, 3.4
 *
 * 属性描述：
 * 对于任意买入价格和当前价格，盈亏比例应满足
 * (currentPrice - purchasePrice) / purchasePrice * 100；
 * 持仓总盈亏应等于所有持仓股票盈亏之和（等权重平均）。
 *
 * 测试策略：
 * 1. 使用 fast-check 生成随机的 purchasePrice 和 currentPrice（均为正数）
 * 2. 调用 SpecialKeywordMap.calculatePositionProfit() 验证计算结果
 * 3. 验证单只股票盈亏公式正确性
 * 4. 验证多只股票等权重平均的正确性
 */

import * as fc from 'fast-check';
import { SpecialKeywordMap } from '../../business/SpecialKeywordMap';
import { StockEntry } from '../../types';

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function makeEntry(code: string, purchasePrice: number): StockEntry {
  return {
    code,
    name: `股票_${code}`,
    purchasePrice,
    addedAt: Date.now(),
  };
}

/** 计算单只股票盈亏比例（参考公式） */
function expectedProfit(currentPrice: number, purchasePrice: number): number {
  return (currentPrice - purchasePrice) / purchasePrice * 100;
}

// ─── 价格生成器 ───────────────────────────────────────────────────────────────

/** 生成正数价格（0.01 ~ 9999），避免 NaN/Infinity */
const positivePriceArb = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(9999),
  noNaN: true,
}).filter(v => v > 0 && isFinite(v));

/** 生成唯一股票代码 */
function makeCode(index: number): string {
  return `sh${String(600000 + index).padStart(6, '0')}`;
}

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 8: 盈亏计算正确性', () => {

  test('单只股票盈亏比例满足 (currentPrice - purchasePrice) / purchasePrice * 100', () => {
    const map = new SpecialKeywordMap();

    fc.assert(
      fc.property(
        positivePriceArb, // purchasePrice
        positivePriceArb, // currentPrice
        (purchasePrice, currentPrice) => {
          const entry = makeEntry('sh600036', purchasePrice);
          const priceMap = new Map([['sh600036', currentPrice]]);

          const result = map.calculatePositionProfit([entry], priceMap);
          const expected = expectedProfit(currentPrice, purchasePrice);

          // 结果不应为 null
          if (result === null) { return false; }

          // 允许浮点误差 1e-4
          return Math.abs(result - expected) < 1e-4;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('多只股票总盈亏等于各股票盈亏的等权重平均', () => {
    const map = new SpecialKeywordMap();

    // 生成 2~5 只股票的价格对列表
    const stockPairsArb = fc.array(
      fc.tuple(positivePriceArb, positivePriceArb),
      { minLength: 2, maxLength: 5 }
    );

    fc.assert(
      fc.property(stockPairsArb, (pairs) => {
        const entries: StockEntry[] = pairs.map(([purchasePrice], i) =>
          makeEntry(makeCode(i), purchasePrice)
        );

        const priceMap = new Map<string, number>(
          pairs.map(([, currentPrice], i) => [makeCode(i), currentPrice])
        );

        const result = map.calculatePositionProfit(entries, priceMap);
        if (result === null) { return false; }

        // 手动计算等权重平均
        const profits = pairs.map(([purchasePrice, currentPrice]) =>
          expectedProfit(currentPrice, purchasePrice)
        );
        const expected = profits.reduce((sum, p) => sum + p, 0) / profits.length;

        return Math.abs(result - expected) < 1e-4;
      }),
      { numRuns: 100 }
    );
  });

  test('无持仓股票（无 purchasePrice）时返回 null', () => {
    const map = new SpecialKeywordMap();

    fc.assert(
      fc.property(positivePriceArb, (currentPrice) => {
        // 股票条目没有 purchasePrice
        const entry: StockEntry = {
          code: 'sh600036',
          name: '测试股票',
          addedAt: Date.now(),
        };
        const priceMap = new Map([['sh600036', currentPrice]]);
        return map.calculatePositionProfit([entry], priceMap) === null;
      }),
      { numRuns: 100 }
    );
  });

  test('上涨时盈亏为正，下跌时盈亏为负，持平时盈亏为零', () => {
    const map = new SpecialKeywordMap();

    fc.assert(
      fc.property(positivePriceArb, positivePriceArb, (purchasePrice, currentPrice) => {
        const entry = makeEntry('sh600036', purchasePrice);
        const priceMap = new Map([['sh600036', currentPrice]]);
        const result = map.calculatePositionProfit([entry], priceMap);

        if (result === null) { return false; }

        if (currentPrice > purchasePrice) {
          return result > 0;
        } else if (currentPrice < purchasePrice) {
          return result < 0;
        } else {
          return Math.abs(result) < 1e-10;
        }
      }),
      { numRuns: 100 }
    );
  });

});
