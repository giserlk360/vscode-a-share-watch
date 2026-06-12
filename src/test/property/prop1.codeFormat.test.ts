// Feature: vscode-stock-monitor, Property 1: 股票代码格式化可逆性

/**
 * 属性测试：股票代码格式化可逆性
 * Validates: Requirements 2.5, 2.1, 2.3
 *
 * 属性描述：
 * 对于任意有效的 A 股纯数字代码（6位），resolveMarketPrefix(code) 添加市场前缀后，
 * 去掉前缀应能还原原始代码；且：
 *   - 沪市代码（首位 6/9）始终得到 sh 前缀
 *   - 深市代码（首位 0/2/3）始终得到 sz 前缀
 *   - ETF（首位 1/5）始终得到 sz 前缀
 */

import * as fc from 'fast-check';
import { StockDataProvider } from '../../data/StockDataProvider';

const provider = new StockDataProvider();

// ─── 辅助生成器 ───────────────────────────────────────────────────────────────

/** 生成首位为指定字符集、后5位随机数字的6位代码 */
function codeArb(firstDigits: string[]): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...firstDigits),
    fc.stringOf(fc.char().filter(c => c >= '0' && c <= '9'), { minLength: 5, maxLength: 5 })
  ).map(([first, rest]) => `${first}${rest}`);
}

const shCodeArb = codeArb(['6', '9']);
const szCodeArb = codeArb(['0', '2', '3']);
const etfCodeArb = codeArb(['1', '5']);

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 1: 股票代码格式化可逆性', () => {

  test('沪市代码（首位6/9）始终得到 sh 前缀，去掉前缀可还原原始代码', () => {
    fc.assert(
      fc.property(shCodeArb, (code) => {
        const result = provider.resolveMarketPrefix(code);
        // 必须以 sh 开头
        expect(result.startsWith('sh')).toBe(true);
        // 去掉前缀后应还原原始代码
        expect(result.slice(2)).toBe(code);
      }),
      { numRuns: 100 }
    );
  });

  test('深市代码（首位0/2/3）始终得到 sz 前缀，去掉前缀可还原原始代码', () => {
    fc.assert(
      fc.property(szCodeArb, (code) => {
        // 排除特殊代码 000001（上证指数，会得到 sh 前缀）
        if (code === '000001') { return; }
        const result = provider.resolveMarketPrefix(code);
        // 必须以 sz 开头
        expect(result.startsWith('sz')).toBe(true);
        // 去掉前缀后应还原原始代码
        expect(result.slice(2)).toBe(code);
      }),
      { numRuns: 100 }
    );
  });

  test('ETF 代码（首位1/5）始终得到 sz 前缀，去掉前缀可还原原始代码', () => {
    fc.assert(
      fc.property(etfCodeArb, (code) => {
        const result = provider.resolveMarketPrefix(code);
        // 必须以 sz 开头
        expect(result.startsWith('sz')).toBe(true);
        // 去掉前缀后应还原原始代码
        expect(result.slice(2)).toBe(code);
      }),
      { numRuns: 100 }
    );
  });

  test('所有有效6位代码：去掉前缀后均能还原原始代码（可逆性）', () => {
    const allValidFirstDigits = ['0', '1', '2', '3', '5', '6', '9'];
    const allValidCodeArb = codeArb(allValidFirstDigits);

    fc.assert(
      fc.property(allValidCodeArb, (code) => {
        const result = provider.resolveMarketPrefix(code);
        // 结果必须以 sh 或 sz 开头
        const hasValidPrefix = result.startsWith('sh') || result.startsWith('sz');
        expect(hasValidPrefix).toBe(true);
        // 去掉前缀（2个字符）后应还原原始代码
        expect(result.slice(2)).toBe(code);
      }),
      { numRuns: 100 }
    );
  });

});
