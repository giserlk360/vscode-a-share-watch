/**
 * SpecialKeywordMap 单元测试
 * 覆盖内置映射、用户别名、持仓关键词、盈亏计算等核心逻辑
 */

import { SpecialKeywordMap, POSITION_SYMBOL, POSITION_KEYWORD } from '../../business/SpecialKeywordMap';
import { StockEntry } from '../../types';

// ─── 测试辅助函数 ─────────────────────────────────────────────────────────────

function makeEntry(code: string, alias?: string, purchasePrice?: number): StockEntry {
  return {
    code,
    name: `股票_${code}`,
    alias,
    purchasePrice,
    addedAt: Date.now(),
  };
}

// ─── resolve() 测试 ───────────────────────────────────────────────────────────

describe('SpecialKeywordMap.resolve()', () => {
  let map: SpecialKeywordMap;

  beforeEach(() => {
    map = new SpecialKeywordMap();
  });

  test('空字符串返回 null', () => {
    expect(map.resolve('')).toBeNull();
  });

  test('未知关键词返回 null', () => {
    expect(map.resolve('未知词汇')).toBeNull();
  });

  test('持仓 关键词返回 __POSITION__', () => {
    expect(map.resolve(POSITION_KEYWORD)).toBe(POSITION_SYMBOL);
  });

  test.each([
    ['上证指数', 'sh000001'],
    ['深证成指', 'sz399001'],
    ['创业板指', 'sz399006'],
    ['沪深300', 'sh000300'],
    ['科创50', 'sh000688'],
  ])('内置关键词 "%s" 映射到 "%s"', (keyword, expected) => {
    expect(map.resolve(keyword)).toBe(expected);
  });

  test('用户别名正确解析', () => {
    map.updateUserAliases([makeEntry('sh600036', '招行')]);
    expect(map.resolve('招行')).toBe('sh600036');
  });

  test('用户别名不覆盖内置关键词', () => {
    // 即使用户设置了与内置关键词同名的别名，内置优先
    map.updateUserAliases([makeEntry('sh600036', '上证指数')]);
    expect(map.resolve('上证指数')).toBe('sh000001');
  });
});

// ─── getAllKeywords() 测试 ────────────────────────────────────────────────────

describe('SpecialKeywordMap.getAllKeywords()', () => {
  let map: SpecialKeywordMap;

  beforeEach(() => {
    map = new SpecialKeywordMap();
  });

  test('包含所有内置关键词', () => {
    const keywords = map.getAllKeywords();
    expect(keywords).toContain('上证指数');
    expect(keywords).toContain('深证成指');
    expect(keywords).toContain('创业板指');
    expect(keywords).toContain('沪深300');
    expect(keywords).toContain('科创50');
  });

  test('包含 持仓 关键词', () => {
    expect(map.getAllKeywords()).toContain(POSITION_KEYWORD);
  });

  test('包含用户别名', () => {
    map.updateUserAliases([makeEntry('sh600036', '招行')]);
    expect(map.getAllKeywords()).toContain('招行');
  });

  test('关键词列表无重复', () => {
    map.updateUserAliases([makeEntry('sh600036', '招行'), makeEntry('sz000001', '平安')]);
    const keywords = map.getAllKeywords();
    const unique = new Set(keywords);
    expect(keywords.length).toBe(unique.size);
  });
});

// ─── updateUserAliases() 测试 ─────────────────────────────────────────────────

describe('SpecialKeywordMap.updateUserAliases()', () => {
  let map: SpecialKeywordMap;

  beforeEach(() => {
    map = new SpecialKeywordMap();
  });

  test('空列表不影响内置映射', () => {
    map.updateUserAliases([]);
    expect(map.resolve('上证指数')).toBe('sh000001');
  });

  test('无 alias 的条目不加入映射', () => {
    map.updateUserAliases([makeEntry('sh600036')]);
    // 没有 alias，不应该能通过任何新关键词找到
    expect(map.resolve('股票_sh600036')).toBeNull();
  });

  test('重复调用 updateUserAliases 会覆盖旧别名', () => {
    map.updateUserAliases([makeEntry('sh600036', '招行')]);
    expect(map.resolve('招行')).toBe('sh600036');

    // 更新后旧别名消失
    map.updateUserAliases([makeEntry('sz000001', '平安')]);
    expect(map.resolve('招行')).toBeNull();
    expect(map.resolve('平安')).toBe('sz000001');
  });

  test('alias 前后空格被去除', () => {
    map.updateUserAliases([makeEntry('sh600036', '  招行  ')]);
    expect(map.resolve('招行')).toBe('sh600036');
  });
});

// ─── calculatePositionProfit() 测试 ──────────────────────────────────────────

describe('SpecialKeywordMap.calculatePositionProfit()', () => {
  let map: SpecialKeywordMap;

  beforeEach(() => {
    map = new SpecialKeywordMap();
  });

  test('无持仓股票返回 null', () => {
    const entries = [makeEntry('sh600036')]; // 无 purchasePrice
    const priceMap = new Map([['sh600036', 40]]);
    expect(map.calculatePositionProfit(entries, priceMap)).toBeNull();
  });

  test('无价格数据返回 null', () => {
    const entries = [makeEntry('sh600036', undefined, 35)];
    const priceMap = new Map<string, number>(); // 空价格表
    expect(map.calculatePositionProfit(entries, priceMap)).toBeNull();
  });

  test('单只股票盈亏计算正确', () => {
    const entries = [makeEntry('sh600036', undefined, 35)];
    const priceMap = new Map([['sh600036', 38.5]]);
    // (38.5 - 35) / 35 * 100 = 10%
    const result = map.calculatePositionProfit(entries, priceMap);
    expect(result).toBeCloseTo(10, 5);
  });

  test('多只股票等权重平均盈亏', () => {
    const entries = [
      makeEntry('sh600036', undefined, 35),  // 盈亏 +10%
      makeEntry('sz000001', undefined, 20),  // 盈亏 -10%
    ];
    const priceMap = new Map([
      ['sh600036', 38.5],  // (38.5-35)/35*100 = +10%
      ['sz000001', 18],    // (18-20)/20*100 = -10%
    ]);
    // 平均 = (10 + (-10)) / 2 = 0%
    const result = map.calculatePositionProfit(entries, priceMap);
    expect(result).toBeCloseTo(0, 5);
  });

  test('亏损场景计算正确', () => {
    const entries = [makeEntry('sh600036', undefined, 40)];
    const priceMap = new Map([['sh600036', 36]]);
    // (36 - 40) / 40 * 100 = -10%
    const result = map.calculatePositionProfit(entries, priceMap);
    expect(result).toBeCloseTo(-10, 5);
  });

  test('部分股票无价格数据时只计算有数据的', () => {
    const entries = [
      makeEntry('sh600036', undefined, 35),
      makeEntry('sz000001', undefined, 20), // 无价格数据
    ];
    const priceMap = new Map([['sh600036', 38.5]]); // 只有第一只
    // 只计算 sh600036: (38.5-35)/35*100 = 10%
    const result = map.calculatePositionProfit(entries, priceMap);
    expect(result).toBeCloseTo(10, 5);
  });
});
