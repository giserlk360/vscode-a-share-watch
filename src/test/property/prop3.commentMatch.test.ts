// Feature: vscode-stock-monitor, Property 3: 注释扫描匹配正确性

/**
 * 属性测试：注释扫描匹配正确性
 * Validates: Requirements 2.1, 3.1, 3.2, 3.3, 3.5, 3.6
 *
 * 属性描述：
 * 对于任意注释文本和股票列表，scanComments(text, stocks) 返回的每个匹配项的
 * code 都应存在于股票列表中（无误匹配）；且文本中所有出现的已注册代码/名称/
 * 别名/特殊词汇都应被找到（无漏匹配）。
 *
 * 测试策略：
 * 1. 生成随机股票列表（StockData + StockEntry）
 * 2. 在 JS 单行注释中嵌入股票代码（6位数字）或股票名称
 * 3. 验证 scanComments 返回的每个 code 都在股票列表中（无误匹配）
 * 4. 验证嵌入的代码/名称都被找到（无漏匹配）
 */

import * as fc from 'fast-check';
import { CommentDecorator } from '../../ui/CommentDecorator';
import { StockData, StockEntry } from '../../types';

// ─── 辅助生成器 ───────────────────────────────────────────────────────────────

/** 生成6位纯数字代码（首位限定为有效 A 股首位） */
const pureDigitsArb: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('0', '1', '2', '3', '5', '6', '9'),
  fc.stringOf(fc.char().filter(c => c >= '0' && c <= '9'), { minLength: 5, maxLength: 5 })
).map(([first, rest]) => `${first}${rest}`);

/** 根据6位纯数字推断带前缀的完整代码 */
function toFullCode(digits: string): string {
  const first = digits[0];
  if (first === '6' || first === '9') {
    return `sh${digits}`;
  }
  return `sz${digits}`;
}

/** 生成简单的中文股票名称（避免与特殊词汇冲突） */
const stockNameArb: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('测试', '模拟', '示例', '随机', '虚拟', '演示', '样本', '数据'),
  fc.constantFrom('股份', '银行', '科技', '能源', '医药', '地产', '电力', '钢铁'),
  fc.nat({ max: 999 })
).map(([prefix, suffix, num]) => `${prefix}${suffix}${num}`);

/** 生成单个 StockData */
function makeStockData(digits: string, name: string): StockData {
  const code = toFullCode(digits);
  return {
    code,
    name,
    currentPrice: 10.0,
    openPrice: 9.9,
    closePrice: 9.8,
    changeAmount: 0.2,
    changeRate: 2.04,
    volume: 10000,
    isETF: false,
    timestamp: Date.now(),
  };
}

/** 生成单个 StockEntry（与 StockData 对应） */
function makeStockEntry(code: string, name: string, alias?: string): StockEntry {
  return {
    code,
    name,
    alias,
    addedAt: Date.now(),
  };
}

/**
 * 生成一组代码唯一的股票（[digits, name] 元组数组），最多 5 只
 * 避免名称中包含特殊词汇（上证、深成、创业板、持仓等）
 */
const SPECIAL_KEYWORDS = ['上证指数', '上证', '深成', '深证成指', '创业板', '创业板指', '沪深300', '科创50', '持仓'];

const stockListArb: fc.Arbitrary<[string, string][]> = fc
  .uniqueArray(
    fc.tuple(pureDigitsArb, stockNameArb) as fc.Arbitrary<[string, string]>,
    {
      selector: ([digits]) => digits,
      minLength: 1,
      maxLength: 5,
    }
  )
  .map(pairs =>
    pairs.filter(([, name]) =>
      !SPECIAL_KEYWORDS.some(kw => name.includes(kw))
    ) as [string, string][]
  )
  .filter(pairs => pairs.length >= 1);

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 3: 注释扫描匹配正确性', () => {

  /**
   * 属性 3a：无误匹配
   * scanComments 返回的每个 match.code 都必须存在于传入的 stocks 列表中
   */
  test('无误匹配：返回的每个 code 都存在于股票列表中', () => {
    fc.assert(
      fc.property(
        stockListArb,
        fc.string({ minLength: 0, maxLength: 50 }),  // 注释前缀文本
        (stockPairs, prefix) => {
          const stocks: StockData[] = stockPairs.map(([d, n]) => makeStockData(d, n));
          const entries: StockEntry[] = stocks.map(s => makeStockEntry(s.code, s.name));
          const codeSet = new Set(stocks.map(s => s.code));

          // 构造包含股票代码的注释文本
          const digits = stockPairs[0][0];
          const text = `// ${prefix} ${digits}`;

          const decorator = new CommentDecorator(entries);
          const matches = decorator.scanComments(text, stocks);

          // 每个匹配的 code 都必须在 stocks 中
          for (const match of matches) {
            expect(codeSet.has(match.code)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 3b：无漏匹配（按代码）
   * 注释中嵌入的6位股票代码，必须被 scanComments 找到
   */
  test('无漏匹配（代码）：注释中嵌入的6位代码必须被找到', () => {
    fc.assert(
      fc.property(
        stockListArb,
        (stockPairs) => {
          const stocks: StockData[] = stockPairs.map(([d, n]) => makeStockData(d, n));
          const entries: StockEntry[] = stocks.map(s => makeStockEntry(s.code, s.name));

          // 将所有股票的6位纯数字代码嵌入注释
          const embeddedDigits = stockPairs.map(([d]) => d);
          const text = `// 关注股票：${embeddedDigits.join(' ')}`;

          const decorator = new CommentDecorator(entries);
          const matches = decorator.scanComments(text, stocks);

          const foundCodes = new Set(matches.map(m => m.code));

          // 每个嵌入的代码都应被找到
          for (const digits of embeddedDigits) {
            const fullCode = toFullCode(digits);
            expect(foundCodes.has(fullCode)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 3c：无漏匹配（按名称）
   * 注释中嵌入的股票名称，必须被 scanComments 找到
   * 只验证名称不是其他名称子串的情况（避免子串歧义）
   */
  test('无漏匹配（名称）：注释中嵌入的股票名称必须被找到', () => {
    fc.assert(
      fc.property(
        stockListArb,
        (stockPairs) => {
          const stocks: StockData[] = stockPairs.map(([d, n]) => makeStockData(d, n));
          const entries: StockEntry[] = stocks.map(s => makeStockEntry(s.code, s.name));

          // 将所有股票名称嵌入注释
          const embeddedNames = stockPairs.map(([, n]) => n);
          const text = `// 持仓：${embeddedNames.join('，')}`;

          const decorator = new CommentDecorator(entries);
          const matches = decorator.scanComments(text, stocks);

          const foundCodes = new Set(matches.map(m => m.code));

          // 每个嵌入的名称对应的 code 都应被找到
          // 只验证：该名称不是其他任何名称的子串（避免被更长名称的匹配覆盖位置）
          for (const [digits, name] of stockPairs) {
            const fullCode = toFullCode(digits);
            // 该名称不是其他名称的子串（即不会被其他名称的匹配"吃掉"）
            const notSubstringOfOthers = stockPairs.every(
              ([, otherName]) => otherName === name || !otherName.includes(name)
            );
            if (notSubstringOfOthers) {
              expect(foundCodes.has(fullCode)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 3d：无漏匹配（按别名）
   * 注释中嵌入的用户别名，必须被 scanComments 找到
   * 别名需满足：不是其他别名/名称/代码的子串，且不含特殊字符
   */
  test('无漏匹配（别名）：注释中嵌入的用户别名必须被找到', () => {
    // 生成安全别名：纯中文，长度 3-6，避免与代码数字/特殊词汇冲突
    const safeAliasArb = fc.tuple(
      fc.constantFrom('招行', '茅台', '平安', '工行', '建行', '中行', '农行', '交行'),
      fc.nat({ max: 9999 })
    ).map(([prefix, num]) => `${prefix}${num}`);

    fc.assert(
      fc.property(
        stockListArb,
        fc.uniqueArray(safeAliasArb, { minLength: 1, maxLength: 5 }),
        (stockPairs, aliases) => {
          const count = Math.min(stockPairs.length, aliases.length);
          if (count === 0) { return; }

          const stocks: StockData[] = stockPairs.slice(0, count).map(([d, n]) => makeStockData(d, n));
          const entries: StockEntry[] = stocks.map((s, i) =>
            makeStockEntry(s.code, s.name, aliases[i])
          );

          const embeddedAliases = aliases.slice(0, count);
          const text = `// 别名测试：${embeddedAliases.join(' ')}`;

          const decorator = new CommentDecorator(entries);
          const matches = decorator.scanComments(text, stocks);

          const foundCodes = new Set(matches.map(m => m.code));

          for (let i = 0; i < count; i++) {
            const alias = embeddedAliases[i];
            const fullCode = stocks[i].code;

            // 只验证：该别名不是其他别名的子串（避免位置被更长别名覆盖）
            const notSubstringOfOthers = embeddedAliases.every(
              (other, j) => j === i || !other.includes(alias)
            );
            if (notSubstringOfOthers) {
              expect(foundCodes.has(fullCode)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 3e：空股票列表时无匹配
   * 当 stocks 为空时，scanComments 应返回空数组
   */
  test('空股票列表时返回空匹配', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (text) => {
          const decorator = new CommentDecorator([]);
          const matches = decorator.scanComments(text, []);
          expect(matches).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * 属性 3f：非注释区域不产生匹配
   * 股票代码出现在非注释区域时，不应被匹配
   */
  test('非注释区域的股票代码不被匹配', () => {
    fc.assert(
      fc.property(
        stockListArb,
        (stockPairs) => {
          const stocks: StockData[] = stockPairs.map(([d, n]) => makeStockData(d, n));
          const entries: StockEntry[] = stocks.map(s => makeStockEntry(s.code, s.name));

          // 代码出现在非注释区域（普通字符串赋值，无注释符号）
          const digits = stockPairs[0][0];
          const text = `const code = "${digits}";`;

          const decorator = new CommentDecorator(entries);
          const matches = decorator.scanComments(text, stocks);

          // 非注释区域不应有匹配
          expect(matches).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

});
