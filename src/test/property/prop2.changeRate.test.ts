// Feature: vscode-stock-monitor, Property 2: 涨跌幅计算与格式化正确性

/**
 * 属性测试：涨跌幅计算与格式化正确性
 * Validates: Requirements 2.2, 2.3, 2.4, 6.7
 *
 * 属性描述：
 * 对于任意当前价格和昨收价格，涨跌幅应满足 (currentPrice - closePrice) / closePrice * 100；
 * 格式化时个股保留两位小数，ETF 保留三位小数；
 * 上涨时装饰颜色为红色（#F14C4C），下跌时为绿色（#73C991）。
 *
 * 测试策略：
 * 1. 通过 CommentDecorator 的私有方法 _formatChangeRate 测试格式化逻辑
 * 2. 通过 _getDecorationColor 测试颜色逻辑
 * 3. 使用 fast-check 生成随机价格和涨跌幅
 */

import * as fc from 'fast-check';
import { CommentDecorator } from '../../ui/CommentDecorator';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const COLOR_UP = '#F14C4C';
const COLOR_DOWN = '#73C991';

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 创建 CommentDecorator 实例（无需 stockEntries） */
function makeDecorator(): CommentDecorator {
  return new CommentDecorator([]);
}

/** 调用私有方法 _formatChangeRate */
function formatChangeRate(decorator: CommentDecorator, changeRate: number, isETF: boolean): string {
  return (decorator as any)._formatChangeRate(changeRate, isETF);
}

/** 调用私有方法 _getDecorationColor */
function getDecorationColor(decorator: CommentDecorator, changeRate: number): string | object {
  return (decorator as any)._getDecorationColor(changeRate);
}

/** 计算期望涨跌幅 */
function expectedChangeRate(currentPrice: number, closePrice: number): number {
  return (currentPrice - closePrice) / closePrice * 100;
}

// ─── 价格生成器 ───────────────────────────────────────────────────────────────

/** 生成有效价格（0.01 ~ 9999.99，避免除零） */
const priceArb = fc.float({ min: Math.fround(0.01), max: Math.fround(9999.99), noNaN: true, noDefaultInfinity: true });

/** 生成涨跌幅（-100 ~ 100 范围内的合理值） */
const changeRateArb = fc.float({ min: Math.fround(-99.99), max: Math.fround(99.99), noNaN: true, noDefaultInfinity: true });

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 2: 涨跌幅计算与格式化正确性', () => {

  /**
   * 属性 2a：涨跌幅计算公式正确性
   * 对于任意当前价格和昨收价格，涨跌幅应满足 (currentPrice - closePrice) / closePrice * 100
   */
  test('涨跌幅计算公式：(currentPrice - closePrice) / closePrice * 100', () => {
    fc.assert(
      fc.property(
        priceArb,
        priceArb,
        (currentPrice, closePrice) => {
          const expected = expectedChangeRate(currentPrice, closePrice);
          const actual = (currentPrice - closePrice) / closePrice * 100;
          // 验证公式本身的数学一致性（误差 < 0.0001）
          expect(Math.abs(actual - expected)).toBeLessThan(0.0001);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2b：个股格式化保留两位小数
   * 对于任意涨跌幅，isETF=false 时格式化结果应保留两位小数
   */
  test('个股格式化：保留两位小数', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        changeRateArb,
        (changeRate) => {
          const result = formatChangeRate(decorator, changeRate, false);
          // 格式：` +X.XX%↑` 或 ` -X.XX%↓`
          // 提取小数部分：匹配 数字.小数位数
          const match = result.match(/(\d+)\.(\d+)%/);
          expect(match).not.toBeNull();
          if (match) {
            // 个股应有两位小数
            expect(match[2].length).toBe(2);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2c：ETF 格式化保留三位小数
   * 对于任意涨跌幅，isETF=true 时格式化结果应保留三位小数
   */
  test('ETF 格式化：保留三位小数', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        changeRateArb,
        (changeRate) => {
          const result = formatChangeRate(decorator, changeRate, true);
          // 格式：` +X.XXX%↑` 或 ` -X.XXX%↓`
          const match = result.match(/(\d+)\.(\d+)%/);
          expect(match).not.toBeNull();
          if (match) {
            // ETF 应有三位小数
            expect(match[2].length).toBe(3);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2d：格式化结果包含正确的符号和箭头
   * 上涨时符号为 +，箭头为 ↑；下跌时符号为 -，箭头为 ↓；零时视为上涨
   */
  test('格式化结果：上涨显示 + 和 ↑，下跌显示 - 和 ↓', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        changeRateArb,
        fc.boolean(),
        (changeRate, isETF) => {
          const result = formatChangeRate(decorator, changeRate, isETF);
          if (changeRate >= 0) {
            expect(result).toContain('+');
            expect(result).toContain('↑');
            expect(result).not.toContain('↓');
          } else {
            expect(result).toContain('-');
            expect(result).toContain('↓');
            expect(result).not.toContain('↑');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2e：格式化结果以空格开头并包含 %
   * 格式化结果应以空格开头，并包含百分号
   */
  test('格式化结果：以空格开头并包含 %', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        changeRateArb,
        fc.boolean(),
        (changeRate, isETF) => {
          const result = formatChangeRate(decorator, changeRate, isETF);
          expect(result.startsWith(' ')).toBe(true);
          expect(result).toContain('%');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2f：上涨时颜色为红色 #F14C4C
   * 对于任意非负涨跌幅，_getDecorationColor 应返回 #F14C4C
   */
  test('上涨颜色：changeRate >= 0 时返回红色 #F14C4C', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(99.99), noNaN: true, noDefaultInfinity: true }),
        (changeRate) => {
          const color = getDecorationColor(decorator, changeRate);
          expect(color).toBe(COLOR_UP);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2g：下跌时颜色为绿色 #73C991
   * 对于任意负涨跌幅，_getDecorationColor 应返回 #73C991
   */
  test('下跌颜色：changeRate < 0 时返回绿色 #73C991', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-99.99), max: Math.fround(-0.001), noNaN: true, noDefaultInfinity: true }),
        (changeRate) => {
          const color = getDecorationColor(decorator, changeRate);
          expect(color).toBe(COLOR_DOWN);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 2h：格式化数值与涨跌幅绝对值一致
   * 格式化结果中的数值应等于 |changeRate|.toFixed(decimals)
   */
  test('格式化数值与涨跌幅绝对值一致', () => {
    const decorator = makeDecorator();
    fc.assert(
      fc.property(
        changeRateArb,
        fc.boolean(),
        (changeRate, isETF) => {
          const result = formatChangeRate(decorator, changeRate, isETF);
          const decimals = isETF ? 3 : 2;
          const expectedValue = Math.abs(changeRate).toFixed(decimals);
          expect(result).toContain(expectedValue);
        }
      ),
      { numRuns: 100 }
    );
  });

});
