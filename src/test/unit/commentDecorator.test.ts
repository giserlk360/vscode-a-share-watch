/**
 * CommentDecorator 单元测试
 * 需求参考：2.2, 2.3, 2.4, 2.5
 */

import { CommentDecorator } from '../../ui/CommentDecorator';
import { ThemeColor } from '../__mocks__/vscode';
import { StockData, StockEntry, CommentMatch } from '../../types';

// ─── 辅助工厂 ─────────────────────────────────────────────────────────────────

function makeStock(overrides: Partial<StockData> = {}): StockData {
  return {
    code: 'sh600036',
    name: '招商银行',
    currentPrice: 50,
    openPrice: 48,
    closePrice: 47,
    changeAmount: 3,
    changeRate: 4.79,
    volume: 10000,
    isETF: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<StockEntry> = {}): StockEntry {
  return {
    code: 'sh600036',
    name: '招商银行',
    carouselEnabled: true,
    addedAt: Date.now(),
    ...overrides,
  };
}

// ─── 各语言注释扫描 ───────────────────────────────────────────────────────────

describe('各语言注释扫描', () => {
  const stock = makeStock({ code: 'sh600036', name: '招商银行' });
  const entry = makeEntry({ code: 'sh600036', name: '招商银行' });
  const stocks = [stock];

  test('JS/TS 单行注释 // 中的6位代码被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '// 关注 600036 涨跌';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('Python 注释 # 中的6位代码被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '# 关注 600036 涨跌';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('SQL 注释 -- 中的6位代码被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '-- 关注 600036 涨跌';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('HTML 注释 <!-- --> 中的6位代码被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '<!-- 关注 600036 涨跌 -->';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('JS/TS 单行注释中的股票名称被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '// 招商银行 今日行情';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('Python 注释中的股票名称被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = '# 招商银行 今日行情';
    const matches = decorator.scanComments(text, stocks);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('非注释区域的6位代码不被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = 'const code = "600036";';
    const matches = decorator.scanComments(text, stocks);

    expect(matches).toHaveLength(0);
  });

  test('非注释区域的股票名称不被识别', () => {
    const decorator = new CommentDecorator([entry]);
    const text = 'const name = "招商银行";';
    const matches = decorator.scanComments(text, stocks);

    expect(matches).toHaveLength(0);
  });
});

// ─── 隐蔽模式颜色 ─────────────────────────────────────────────────────────────

describe('隐蔽模式颜色（需求 2.5）', () => {
  test('setStealthMode(true) 后 _getDecorationColor 返回 ThemeColor 对象', () => {
    const decorator = new CommentDecorator([]);
    decorator.setStealthMode(true);

    const color = (decorator as any)._getDecorationColor(5);
    expect(color).toBeInstanceOf(ThemeColor);
  });

  test('setStealthMode(true) 后上涨股票颜色也是 ThemeColor', () => {
    const decorator = new CommentDecorator([]);
    decorator.setStealthMode(true);

    const color = (decorator as any)._getDecorationColor(3.5);
    expect(color).toBeInstanceOf(ThemeColor);
  });

  test('setStealthMode(true) 后下跌股票颜色也是 ThemeColor', () => {
    const decorator = new CommentDecorator([]);
    decorator.setStealthMode(true);

    const color = (decorator as any)._getDecorationColor(-2.1);
    expect(color).toBeInstanceOf(ThemeColor);
  });

  test('setStealthMode(false) 后颜色不再是 ThemeColor', () => {
    const decorator = new CommentDecorator([]);
    decorator.setStealthMode(true);
    decorator.setStealthMode(false);

    const color = (decorator as any)._getDecorationColor(5);
    expect(color).not.toBeInstanceOf(ThemeColor);
  });
});

// ─── 正常模式颜色 ─────────────────────────────────────────────────────────────

describe('正常模式颜色（需求 2.4）', () => {
  test('上涨时颜色为红色 #F14C4C', () => {
    const decorator = new CommentDecorator([]);
    const color = (decorator as any)._getDecorationColor(4.79);
    expect(color).toBe('#F14C4C');
  });

  test('下跌时颜色为绿色 #73C991', () => {
    const decorator = new CommentDecorator([]);
    const color = (decorator as any)._getDecorationColor(-2.49);
    expect(color).toBe('#73C991');
  });

  test('涨跌幅为 0 时颜色为红色 #F14C4C（视为上涨）', () => {
    const decorator = new CommentDecorator([]);
    const color = (decorator as any)._getDecorationColor(0);
    expect(color).toBe('#F14C4C');
  });
});

// ─── ETF 三位小数，个股两位小数（需求 2.2, 2.3）────────────────────────────────

describe('ETF 三位小数，个股两位小数（需求 2.2, 2.3）', () => {
  test('个股涨跌幅显示两位小数', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(4.789, false);
    // 应包含两位小数
    expect(text).toMatch(/\+4\.79%/);
  });

  test('ETF 涨跌幅显示三位小数', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(4.789, true);
    // 应包含三位小数
    expect(text).toMatch(/\+4\.789%/);
  });

  test('个股下跌显示两位小数', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(-2.499, false);
    expect(text).toMatch(/-2\.50%/);
  });

  test('ETF 下跌显示三位小数', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(-2.499, true);
    expect(text).toMatch(/-2\.499%/);
  });

  test('个股上涨带 + 号和 ↑ 箭头', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(3.14, false);
    expect(text).toContain('+');
    expect(text).toContain('↑');
  });

  test('个股下跌带 - 号和 ↓ 箭头', () => {
    const decorator = new CommentDecorator([]);
    const text = (decorator as any)._formatChangeRate(-3.14, false);
    expect(text).toContain('-');
    expect(text).toContain('↓');
  });

  test('ETF 股票在 scanComments 匹配后格式化为三位小数', () => {
    const etfStock = makeStock({
      code: 'sz159915',
      name: '创业板ETF',
      changeRate: 1.2345,
      isETF: true,
    });
    const etfEntry = makeEntry({ code: 'sz159915', name: '创业板ETF' });
    const decorator = new CommentDecorator([etfEntry]);
    const text = '// 关注 159915';
    const matches = decorator.scanComments(text, [etfStock]);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sz159915');

    // 验证 ETF 格式化三位小数
    const formatted = (decorator as any)._formatChangeRate(etfStock.changeRate, etfStock.isETF);
    expect(formatted).toMatch(/\+1\.234%/);
  });
});

// ─── 匹配优先级（需求 2.1）────────────────────────────────────────────────────

describe('匹配优先级：特殊词汇 > 别名 > 名称 > 代码', () => {
  test('特殊词汇"上证指数"被识别为 sh000001', () => {
    const indexStock = makeStock({ code: 'sh000001', name: '上证指数' });
    const decorator = new CommentDecorator([]);
    const text = '// 上证指数 今日行情';
    const matches = decorator.scanComments(text, [indexStock]);

    expect(matches.length).toBeGreaterThan(0);
    const specialMatch = matches.find(m => m.matchType === 'special');
    expect(specialMatch).toBeDefined();
    expect(specialMatch!.code).toBe('sh000001');
  });

  test('用户别名能被识别并映射到正确的股票代码', () => {
    const stock = makeStock({ code: 'sh600036', name: '招商银行' });
    const entry = makeEntry({ code: 'sh600036', name: '招商银行', alias: '招行' });
    const decorator = new CommentDecorator([entry]);
    const text = '// 招行 今日行情';
    const matches = decorator.scanComments(text, [stock]);

    // 别名由 specialKeywordMap 统一处理，matchType 为 'special'
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].code).toBe('sh600036');
  });

  test('官方名称匹配类型为 name', () => {
    const stock = makeStock({ code: 'sh600036', name: '招商银行' });
    const entry = makeEntry({ code: 'sh600036', name: '招商银行' });
    const decorator = new CommentDecorator([entry]);
    const text = '// 招商银行 今日行情';
    const matches = decorator.scanComments(text, [stock]);

    expect(matches.length).toBeGreaterThan(0);
    const nameMatch = matches.find(m => m.matchType === 'name');
    expect(nameMatch).toBeDefined();
    expect(nameMatch!.code).toBe('sh600036');
  });

  test('6位代码匹配类型为 code', () => {
    const stock = makeStock({ code: 'sh600036', name: '招商银行' });
    const entry = makeEntry({ code: 'sh600036', name: '招商银行' });
    const decorator = new CommentDecorator([entry]);
    const text = '// 600036';
    const matches = decorator.scanComments(text, [stock]);

    expect(matches.length).toBeGreaterThan(0);
    const codeMatch = matches.find(m => m.matchType === 'code');
    expect(codeMatch).toBeDefined();
    expect(codeMatch!.code).toBe('sh600036');
  });

  test('同一位置特殊词汇优先于代码匹配（不重复记录同一位置）', () => {
    // 上证指数代码 000001 出现在注释中，同时"上证指数"也出现
    const indexStock = makeStock({ code: 'sh000001', name: '上证指数' });
    const decorator = new CommentDecorator([]);
    // 文本中同时包含特殊词汇和代码，但位置不同
    const text = '// 上证指数 000001';
    const matches = decorator.scanComments(text, [indexStock]);

    // 特殊词汇"上证指数"应被识别
    const specialMatch = matches.find(m => m.matchType === 'special');
    expect(specialMatch).toBeDefined();
  });
});

// ─── 空文本返回空匹配 ─────────────────────────────────────────────────────────

describe('空文本返回空匹配', () => {
  test('空字符串返回空数组', () => {
    const stock = makeStock();
    const entry = makeEntry();
    const decorator = new CommentDecorator([entry]);
    const matches = decorator.scanComments('', [stock]);

    expect(matches).toHaveLength(0);
  });

  test('无注释的纯代码文本返回空数组', () => {
    const stock = makeStock();
    const entry = makeEntry();
    const decorator = new CommentDecorator([entry]);
    const text = 'const x = 1;\nlet y = 2;';
    const matches = decorator.scanComments(text, [stock]);

    expect(matches).toHaveLength(0);
  });

  test('stocks 为空时仍能匹配注释中的股票代码', () => {
    const decorator = new CommentDecorator([]);
    const text = '// 600036 招商银行';
    const matches = decorator.scanComments(text, []);

    // 即使 stocks 为空，6位代码也应被识别（根据代码规则推断前缀）
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.code === 'sh600036')).toBe(true);
  });
});
