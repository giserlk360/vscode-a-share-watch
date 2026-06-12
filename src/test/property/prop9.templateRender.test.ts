// Feature: vscode-stock-monitor, Property 9: 弹窗模板渲染完整性

/**
 * 属性测试：弹窗模板渲染完整性
 * Validates: Requirements 5.8, 5.9
 *
 * 属性描述：
 * 对于任意包含 {name}、{price}、{changeRate} 占位符的模板字符串和股票数据，
 * 渲染后的字符串中所有占位符都应被替换为对应的实际值，且不出现未替换的占位符。
 *
 * 测试策略：
 * 1. 使用 fast-check 生成包含随机占位符组合的模板字符串
 * 2. 调用 AlertSystem.renderTemplate() 方法（公开方法）
 * 3. 验证渲染后的字符串不包含 {name}、{price}、{changeRate} 占位符
 * 4. 验证实际值被正确替换
 */

import * as fc from 'fast-check';
import { AlertSystem } from '../../business/AlertSystem';
import { MockExtensionContext } from '../__mocks__/vscode';
import { StockData, AlertConfig } from '../../types';

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 构造一个最小化的 StockData */
function makeStockData(
  name: string,
  currentPrice: number,
  changeRate: number,
): StockData {
  return {
    code: 'sh600036',
    name,
    currentPrice,
    openPrice: currentPrice,
    closePrice: currentPrice,
    changeAmount: 0,
    changeRate,
    volume: 1000,
    isETF: false,
    timestamp: Date.now(),
  };
}

/** 创建 AlertSystem 实例 */
function makeAlertSystem(): AlertSystem {
  const ctx = new MockExtensionContext();
  const config: AlertConfig = {
    mode: 'popup',
    popupTemplate: '{name} {price} {changeRate}',
    intenseDuration: 60,
  };
  return new AlertSystem(ctx as any, config);
}

// ─── 占位符生成器 ─────────────────────────────────────────────────────────────

/** 三个占位符的所有子集（非空），用于随机组合模板 */
const PLACEHOLDERS = ['{name}', '{price}', '{changeRate}'] as const;

/** 生成包含随机占位符组合的模板字符串 */
const templateArb: fc.Arbitrary<string> = fc
  .subarray(PLACEHOLDERS as unknown as string[], { minLength: 1 })
  .chain((placeholders) =>
    // 在占位符之间插入随机文本片段
    fc
      .array(fc.string({ maxLength: 20 }), {
        minLength: placeholders.length + 1,
        maxLength: placeholders.length + 1,
      })
      .map((parts) => {
        // 交错拼接：text0 + placeholder0 + text1 + placeholder1 + ...
        let result = parts[0];
        for (let i = 0; i < placeholders.length; i++) {
          result += placeholders[i] + parts[i + 1];
        }
        return result;
      }),
  );

/** 生成有效的股票名称（非空字符串，不含占位符字符） */
const stockNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((s) => !s.includes('{') && !s.includes('}'));

/** 生成有效的正数价格（0.01 ~ 9999） */
const priceArb: fc.Arbitrary<number> = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(9999),
  noNaN: true,
});

/** 生成涨跌幅（-100 ~ 100，百分比） */
const changeRateArb: fc.Arbitrary<number> = fc.float({
  min: Math.fround(-100),
  max: Math.fround(100),
  noNaN: true,
});

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 9: 弹窗模板渲染完整性', () => {

  // ── 属性 9a：渲染后不含任何未替换的占位符 ─────────────────────────────────────

  test('渲染后的字符串不应包含任何未替换的占位符 {name}、{price}、{changeRate}', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        templateArb,
        stockNameArb,
        priceArb,
        changeRateArb,
        (template, name, currentPrice, changeRate) => {
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          // 渲染后不应包含任何占位符
          expect(rendered).not.toContain('{name}');
          expect(rendered).not.toContain('{price}');
          expect(rendered).not.toContain('{changeRate}');
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9b：{name} 被替换为股票名称 ─────────────────────────────────────────

  test('{name} 占位符应被替换为股票的实际名称', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        stockNameArb,
        priceArb,
        changeRateArb,
        (name, currentPrice, changeRate) => {
          const template = '股票名称：{name}';
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          expect(rendered).toBe(`股票名称：${name}`);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9c：{price} 被替换为保留两位小数的当前价格 ──────────────────────────

  test('{price} 占位符应被替换为保留两位小数的当前价格', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        stockNameArb,
        priceArb,
        changeRateArb,
        (name, currentPrice, changeRate) => {
          const template = '当前价格：{price}';
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          const expectedPrice = currentPrice.toFixed(2);
          expect(rendered).toBe(`当前价格：${expectedPrice}`);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9d：{changeRate} 被替换为保留两位小数的涨跌幅 ───────────────────────

  test('{changeRate} 占位符应被替换为保留两位小数的涨跌幅', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        stockNameArb,
        priceArb,
        changeRateArb,
        (name, currentPrice, changeRate) => {
          const template = '涨跌幅：{changeRate}%';
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          const expectedRate = changeRate.toFixed(2);
          expect(rendered).toBe(`涨跌幅：${expectedRate}%`);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9e：多个占位符同时出现时全部被正确替换 ──────────────────────────────

  test('模板中同时包含所有三个占位符时，全部应被正确替换', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        stockNameArb,
        priceArb,
        changeRateArb,
        (name, currentPrice, changeRate) => {
          const template = '⚠️ {name} 已达目标价！当前价格：{price}，涨跌幅：{changeRate}%';
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          const expectedPrice = currentPrice.toFixed(2);
          const expectedRate = changeRate.toFixed(2);
          const expected = `⚠️ ${name} 已达目标价！当前价格：${expectedPrice}，涨跌幅：${expectedRate}%`;

          expect(rendered).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9f：占位符多次出现时全部被替换 ──────────────────────────────────────

  test('模板中同一占位符多次出现时，所有出现都应被替换', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        stockNameArb,
        priceArb,
        changeRateArb,
        (name, currentPrice, changeRate) => {
          // 每个占位符出现两次
          const template = '{name} {name} {price} {price} {changeRate} {changeRate}';
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          // 不应有任何未替换的占位符
          expect(rendered).not.toContain('{name}');
          expect(rendered).not.toContain('{price}');
          expect(rendered).not.toContain('{changeRate}');

          // 验证替换值各出现了两次（通过统计子串出现次数）
          const expectedPrice = currentPrice.toFixed(2);
          const expectedRate = changeRate.toFixed(2);

          const countOccurrences = (str: string, sub: string): number => {
            if (sub.length === 0) { return 0; }
            let count = 0;
            let pos = 0;
            while ((pos = str.indexOf(sub, pos)) !== -1) {
              count++;
              pos += sub.length;
            }
            return count;
          };

          expect(countOccurrences(rendered, name)).toBeGreaterThanOrEqual(2);
          expect(countOccurrences(rendered, expectedPrice)).toBeGreaterThanOrEqual(2);
          expect(countOccurrences(rendered, expectedRate)).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

  // ── 属性 9g：不含占位符的模板原样返回 ────────────────────────────────────────

  test('不含任何占位符的模板应原样返回', () => {
    const alertSystem = makeAlertSystem();

    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }).filter(
          (s) => !s.includes('{name}') && !s.includes('{price}') && !s.includes('{changeRate}'),
        ),
        stockNameArb,
        priceArb,
        changeRateArb,
        (template, name, currentPrice, changeRate) => {
          const stock = makeStockData(name, currentPrice, changeRate);
          const rendered = alertSystem.renderTemplate(template, stock);

          // 无占位符时，渲染结果应与模板完全相同
          expect(rendered).toBe(template);
        },
      ),
      { numRuns: 100 },
    );

    alertSystem.dispose();
  });

});
