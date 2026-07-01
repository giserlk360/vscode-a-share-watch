// Feature: vscode-stock-monitor, Property 6: 预警触发条件正确性

/**
 * 属性测试：预警触发条件正确性
 * Validates: Requirements 5.2, 5.3
 *
 * 属性描述：
 * 当且仅当 currentPrice >= targetPrice 或 |changeRate| >= targetChangeRate 时，
 * checkAlerts() 应触发预警（showInformationMessage 或 triggerIntenseAlert 被调用）。
 * 两个条件均不满足时不触发任何预警。
 *
 * 测试策略：
 * 1. mock vscode.window.showInformationMessage 和 triggerIntenseAlert
 * 2. 使用 fast-check 生成随机的 currentPrice、targetPrice、changeRate、targetChangeRate
 * 3. 验证触发/不触发的边界条件
 */

import * as fc from 'fast-check';
import { AlertSystem } from '../../business/AlertSystem';
import { MockExtensionContext } from '../__mocks__/vscode';
import { window as mockWindow } from '../__mocks__/vscode';
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
  addedAt: number;
}

// ─── 辅助生成器 ───────────────────────────────────────────────────────────────

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

/** 生成目标涨跌幅（0 ~ 100，百分比，非负） */
const targetChangeRateArb: fc.Arbitrary<number> = fc.float({
  min: Math.fround(0),
  max: Math.fround(100),
  noNaN: true,
});

/** 构造一个最小化的 StockData */
function makeStockData(currentPrice: number, changeRate: number): StockData {
  return {
    code: 'sh600036',
    name: '招商银行',
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

/** 构造一个最小化的 StockEntry */
function makeStockEntry(
  targetPrice: number | undefined,
  targetChangeRate: number | undefined,
  alertEnabled = true,
): TestStockEntry {
  return {
    code: 'sh600036',
    name: '招商银行',
    alertEnabled,
    addedAt: Date.now(),
    targetPrice,
    targetChangeRate,
  };
}

/** 创建 AlertSystem 实例（popup 模式，方便通过 showInformationMessage 验证触发） */
function makeAlertSystem(ctx: MockExtensionContext): AlertSystem {
  const config: AlertConfig = {
    mode: 'popup',
    popupTemplate: '⚠️ {name} 已达目标价！当前价格：{price}，涨跌幅：{changeRate}%',
    intenseDuration: 60,
  };
  return new AlertSystem(ctx as any, config);
}

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 6: 预警触发条件正确性', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 属性 6a：currentPrice >= targetPrice 时必须触发预警 ──────────────────────

  test('当 currentPrice >= targetPrice 时，checkAlerts() 必须触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        priceArb,
        priceArb,
        async (price1, price2) => {
          // 确保 currentPrice >= targetPrice
          const currentPrice = Math.max(price1, price2);
          const targetPrice = Math.min(price1, price2);

          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          // spy triggerIntenseAlert（popup 模式下不调用，但确保不抛出）
          const triggerIntenseSpy = jest
            .spyOn(alertSystem, 'triggerIntenseAlert')
            .mockImplementation(() => {});

          const stock = makeStockData(currentPrice, 0);
          // targetChangeRate 设为极大值，确保只有价格条件触发
          const entry = makeStockEntry(targetPrice, 999);

          alertSystem.checkAlerts([stock], [entry]);

          // popup 模式下应调用 showInformationMessage
          expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);

          triggerIntenseSpy.mockRestore();
          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── 属性 6b：|changeRate| >= targetChangeRate 时必须触发预警 ─────────────────

  test('当 |changeRate| >= targetChangeRate 时，checkAlerts() 必须触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        changeRateArb,
        targetChangeRateArb,
        async (changeRate, targetChangeRate) => {
          // 确保 |changeRate| >= targetChangeRate
          const absChangeRate = Math.abs(changeRate);
          // 若 absChangeRate < targetChangeRate，则调整 targetChangeRate 使条件成立
          const effectiveTargetChangeRate = absChangeRate >= targetChangeRate
            ? targetChangeRate
            : absChangeRate;

          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          const triggerIntenseSpy = jest
            .spyOn(alertSystem, 'triggerIntenseAlert')
            .mockImplementation(() => {});

          const stock = makeStockData(100, changeRate);
          // targetPrice 设为极大值，确保只有涨跌幅条件触发
          const entry = makeStockEntry(999999, effectiveTargetChangeRate);

          alertSystem.checkAlerts([stock], [entry]);

          expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);

          triggerIntenseSpy.mockRestore();
          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── 属性 6c：两个条件均不满足时不触发预警 ────────────────────────────────────

  test('当 currentPrice < targetPrice 且 |changeRate| < targetChangeRate 时，不触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        priceArb,
        priceArb,
        changeRateArb,
        targetChangeRateArb,
        async (price1, price2, changeRate, targetChangeRate) => {
          // 确保 currentPrice < targetPrice（严格小于）
          const currentPrice = Math.min(price1, price2);
          const targetPrice = Math.max(price1, price2);
          if (currentPrice >= targetPrice) {
            return; // 两值相等时跳过
          }

          // 确保 |changeRate| < targetChangeRate（严格小于）
          const absChangeRate = Math.abs(changeRate);
          const effectiveTargetChangeRate = absChangeRate + Math.abs(targetChangeRate) + 0.001;

          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          const triggerIntenseSpy = jest
            .spyOn(alertSystem, 'triggerIntenseAlert')
            .mockImplementation(() => {});

          const stock = makeStockData(currentPrice, changeRate);
          const entry = makeStockEntry(targetPrice, effectiveTargetChangeRate);

          alertSystem.checkAlerts([stock], [entry]);

          // 两个条件均不满足，不应触发任何预警
          expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
          expect(triggerIntenseSpy).not.toHaveBeenCalled();

          triggerIntenseSpy.mockRestore();
          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── 属性 6d：alertEnabled = false 时不触发预警 ────────────────────────────────

  test('当 alertEnabled = false 时，即使满足价格条件也不触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        priceArb,
        async (price) => {
          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          const triggerIntenseSpy = jest
            .spyOn(alertSystem, 'triggerIntenseAlert')
            .mockImplementation(() => {});

          const stock = makeStockData(price, 50); // changeRate=50，满足涨跌幅条件
          const entry = makeStockEntry(price * 0.5, 1, false); // alertEnabled = false

          alertSystem.checkAlerts([stock], [entry]);

          expect(mockWindow.showInformationMessage).not.toHaveBeenCalled();
          expect(triggerIntenseSpy).not.toHaveBeenCalled();

          triggerIntenseSpy.mockRestore();
          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── 属性 6e：边界条件 currentPrice === targetPrice 时触发预警 ─────────────────

  test('边界条件：currentPrice === targetPrice 时应触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        priceArb,
        async (price) => {
          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          jest.spyOn(alertSystem, 'triggerIntenseAlert').mockImplementation(() => {});

          const stock = makeStockData(price, 0);
          // targetPrice 等于 currentPrice，targetChangeRate 极大（不触发）
          const entry = makeStockEntry(price, 999);

          alertSystem.checkAlerts([stock], [entry]);

          // currentPrice >= targetPrice（等于），应触发
          expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);

          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── 属性 6f：边界条件 |changeRate| === targetChangeRate 时触发预警 ─────────────

  test('边界条件：|changeRate| === targetChangeRate 时应触发预警', async () => {
    await fc.assert(
      fc.asyncProperty(
        targetChangeRateArb,
        async (targetChangeRate) => {
          const ctx = new MockExtensionContext();
          const alertSystem = makeAlertSystem(ctx);

          // 每次迭代前重置 mock
          mockWindow.showInformationMessage.mockClear();

          jest.spyOn(alertSystem, 'triggerIntenseAlert').mockImplementation(() => {});

          // changeRate 等于 targetChangeRate（正值）
          const stock = makeStockData(100, targetChangeRate);
          // targetPrice 极大（不触发价格条件）
          const entry = makeStockEntry(999999, targetChangeRate);

          alertSystem.checkAlerts([stock], [entry]);

          // |changeRate| >= targetChangeRate（等于），应触发
          expect(mockWindow.showInformationMessage).toHaveBeenCalledTimes(1);

          alertSystem.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

});
