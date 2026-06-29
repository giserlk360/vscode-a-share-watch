/**
 * AlertSystem 单元测试
 * 需求参考：5.2, 5.3, 5.8
 */

import { AlertSystem } from '../../business/AlertSystem';
import { MockExtensionContext, window as mockWindow } from '../__mocks__/vscode';
import { StockData } from '../../types';

// ─── 本地类型定义（原 AlertConfig、StockEntry 中的 alert 相关字段已从 types.ts 移除） ──

interface AlertConfig {
  mode: 'popup' | 'intense' | 'both';
  popupTemplate: string;
  intenseDuration: number;
  flashCount?: number;
}

interface TestStockEntry {
  code: string;
  name: string;
  alertEnabled: boolean;
  targetPrice?: number;
  targetChangeRate?: number;
  carouselEnabled: boolean;
  addedAt: number;
}

// ─── 辅助工厂 ─────────────────────────────────────────────────────────────────

function makeStock(overrides: Partial<StockData> = {}): StockData {
  return {
    code: 'sh600036',
    name: '招商银行',
    currentPrice: 50,
    openPrice: 48,
    closePrice: 47,
    changeAmount: 3,
    changeRate: 5,
    volume: 10000,
    isETF: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<TestStockEntry> = {}): TestStockEntry {
  return {
    code: 'sh600036',
    name: '招商银行',
    alertEnabled: true,
    carouselEnabled: false,
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeAlertSystem(mode: AlertConfig['mode'] = 'popup'): AlertSystem {
  const ctx = new MockExtensionContext();
  const config: AlertConfig = {
    mode,
    popupTemplate: '⚠️ {name} 当前价格：{price}，涨跌幅：{changeRate}%',
    intenseDuration: 60,
  };
  return new AlertSystem(ctx as any, config);
}

// ─── 触发边界条件 ─────────────────────────────────────────────────────────────

describe('触发边界条件', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('currentPrice === targetPrice 时触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 50, changeRate: 0 });
    const entry = makeEntry({ targetPrice: 50, targetChangeRate: 999 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });

  test('currentPrice > targetPrice 时触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 55, changeRate: 0 });
    const entry = makeEntry({ targetPrice: 50, targetChangeRate: 999 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });

  test('currentPrice < targetPrice 时不触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 45, changeRate: 0 });
    const entry = makeEntry({ targetPrice: 50, targetChangeRate: 999 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });

  test('|changeRate| === targetChangeRate 时触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 1, changeRate: 5 });
    const entry = makeEntry({ targetPrice: 999999, targetChangeRate: 5 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });

  test('|changeRate| > targetChangeRate 时触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 1, changeRate: 6 });
    const entry = makeEntry({ targetPrice: 999999, targetChangeRate: 5 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });

  test('|changeRate| < targetChangeRate 时不触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 1, changeRate: 4 });
    const entry = makeEntry({ targetPrice: 999999, targetChangeRate: 5 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });

  test('负涨跌幅取绝对值后满足条件时触发预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 1, changeRate: -5 });
    const entry = makeEntry({ targetPrice: 999999, targetChangeRate: 5 });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });
});

// ─── alertEnabled = false 时不触发 ───────────────────────────────────────────

describe('alertEnabled = false 时不触发', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('alertEnabled = false 时，即使价格条件满足也不触发', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 60, changeRate: 10 });
    const entry = makeEntry({ targetPrice: 50, targetChangeRate: 5, alertEnabled: false });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });

  test('alertEnabled = false 时，即使涨跌幅条件满足也不触发', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 1, changeRate: 10 });
    const entry = makeEntry({ targetPrice: 999999, targetChangeRate: 5, alertEnabled: false });

    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });
});

// ─── 模板占位符替换 ───────────────────────────────────────────────────────────

describe('模板占位符替换', () => {
  test('{name} 被替换为股票名称', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ name: '招商银行', currentPrice: 50, changeRate: 3.14 });

    const result = sys.renderTemplate('{name}', stock);

    expect(result).toBe('招商银行');
    sys.dispose();
  });

  test('{price} 被替换为保留两位小数的当前价格', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 50.1, changeRate: 0 });

    const result = sys.renderTemplate('{price}', stock);

    expect(result).toBe('50.10');
    sys.dispose();
  });

  test('{changeRate} 被替换为保留两位小数的涨跌幅', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 50, changeRate: 4.789 });

    const result = sys.renderTemplate('{changeRate}', stock);

    expect(result).toBe('4.79');
    sys.dispose();
  });

  test('三个占位符同时出现时全部被正确替换', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ name: '招商银行', currentPrice: 50, changeRate: 3 });

    const result = sys.renderTemplate('⚠️ {name} 当前价格：{price}，涨跌幅：{changeRate}%', stock);

    expect(result).toBe('⚠️ 招商银行 当前价格：50.00，涨跌幅：3.00%');
    sys.dispose();
  });

  test('同一占位符多次出现时全部被替换', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ name: '招商银行', currentPrice: 50, changeRate: 3 });

    const result = sys.renderTemplate('{name} {name}', stock);

    expect(result).toBe('招商银行 招商银行');
    sys.dispose();
  });
});

// ─── 无占位符模板原样返回 ─────────────────────────────────────────────────────

describe('无占位符模板原样返回', () => {
  test('不含任何占位符的模板原样返回', () => {
    const sys = makeAlertSystem();
    const stock = makeStock();
    const template = '这是一条普通消息，没有占位符';

    const result = sys.renderTemplate(template, stock);

    expect(result).toBe(template);
    sys.dispose();
  });

  test('空字符串模板返回空字符串', () => {
    const sys = makeAlertSystem();
    const stock = makeStock();

    const result = sys.renderTemplate('', stock);

    expect(result).toBe('');
    sys.dispose();
  });
});

// ─── checkAlerts 空列表时不触发 ───────────────────────────────────────────────

describe('checkAlerts 空列表时不触发', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stocks 为空列表时不触发任何预警', () => {
    const sys = makeAlertSystem();
    const entry = makeEntry({ targetPrice: 50 });

    sys.checkAlerts([], [entry]);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });

  test('entries 为空列表时不触发任何预警', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 60 });

    sys.checkAlerts([stock], []);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });

  test('stocks 和 entries 均为空列表时不触发任何预警', () => {
    const sys = makeAlertSystem();

    sys.checkAlerts([], []);

    expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
    sys.dispose();
  });
});

// ─── 同一只股票不重复触发 ─────────────────────────────────────────────────────

describe('同一只股票不重复触发（本次运行周期内去重）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('同一只股票满足条件时，多次调用 checkAlerts 只触发一次', () => {
    const sys = makeAlertSystem();
    const stock = makeStock({ currentPrice: 60, changeRate: 0 });
    const entry = makeEntry({ targetPrice: 50 });

    sys.checkAlerts([stock], [entry]);
    sys.checkAlerts([stock], [entry]);
    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });

  test('不同股票各自只触发一次', () => {
    const sys = makeAlertSystem();
    const stock1 = makeStock({ code: 'sh600036', name: '招商银行', currentPrice: 60, changeRate: 0 });
    const stock2 = makeStock({ code: 'sz000001', name: '平安银行', currentPrice: 20, changeRate: 0 });
    const entry1 = makeEntry({ code: 'sh600036', targetPrice: 50 });
    const entry2 = makeEntry({ code: 'sz000001', targetPrice: 15 });

    sys.checkAlerts([stock1, stock2], [entry1, entry2]);
    sys.checkAlerts([stock1, stock2], [entry1, entry2]);

    // 两只股票各触发一次，共 2 次
    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(2);
    sys.dispose();
  });

  test('代码大小写不同时视为同一只股票，不重复触发', () => {
    const sys = makeAlertSystem();
    // stock.code 小写，entry.code 大写
    const stock = makeStock({ code: 'sh600036', currentPrice: 60, changeRate: 0 });
    const entry = makeEntry({ code: 'SH600036', targetPrice: 50 });

    sys.checkAlerts([stock], [entry]);
    sys.checkAlerts([stock], [entry]);

    expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);
    sys.dispose();
  });
});
