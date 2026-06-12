// Feature: vscode-stock-monitor, Property 5: 导出导入往返一致性

/**
 * 属性测试：导出导入往返一致性
 * Validates: Requirements 1.14, 7.6
 *
 * 属性描述：
 * 对于任意股票列表，执行 exportJSON() 后再 importJSON() 应得到与原始列表
 * 等价的股票列表（所有字段值相同）。
 *
 * 测试策略：
 * 1. 使用 MockExtensionContext 创建 StockManager
 * 2. 添加随机生成的股票列表
 * 3. 调用 exportJSON() 导出
 * 4. 调用 importJSON() 导入到新实例
 * 5. 验证导入后的列表与原始列表完全一致
 */

import * as fc from 'fast-check';
import { StockManager } from '../../data/StockManager';
import { MockExtensionContext } from '../__mocks__/vscode';
import { StockEntry } from '../../types';

// ─── 辅助生成器 ───────────────────────────────────────────────────────────────

/** 生成有效的股票代码（带 sh/sz 前缀的6位数字） */
const validCodeArb: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('sh', 'sz'),
  fc.tuple(
    fc.constantFrom('0', '1', '2', '3', '5', '6', '9'),
    fc.stringOf(fc.char().filter(c => c >= '0' && c <= '9'), { minLength: 5, maxLength: 5 })
  ).map(([first, rest]) => `${first}${rest}`)
).map(([prefix, digits]) => `${prefix}${digits}`);

/** 生成单个 StockEntry */
const stockEntryArb: fc.Arbitrary<StockEntry> = fc.record({
  code: validCodeArb,
  name: fc.string({ minLength: 1, maxLength: 20 }),
  alias: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  purchasePrice: fc.option(
    fc.float({ min: Math.fround(0.01), max: Math.fround(9999), noNaN: true }),
    { nil: undefined }
  ),
  targetPrice: fc.option(
    fc.float({ min: Math.fround(0.01), max: Math.fround(9999), noNaN: true }),
    { nil: undefined }
  ),
  targetChangeRate: fc.option(
    fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }),
    { nil: undefined }
  ),
  alertEnabled: fc.boolean(),
  carouselEnabled: fc.boolean(),
  addedAt: fc.integer({ min: 0, max: Date.now() }),
});

/** 生成一组代码唯一的 StockEntry 列表（1~10 条） */
const uniqueStockListArb: fc.Arbitrary<StockEntry[]> = fc.uniqueArray(stockEntryArb, {
  selector: entry => entry.code.toLowerCase(),
  minLength: 1,
  maxLength: 10,
});

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 比较两个 StockEntry 的所有字段是否一致 */
function assertStockEntryEqual(actual: StockEntry, expected: StockEntry): void {
  expect(actual.code).toBe(expected.code);
  expect(actual.name).toBe(expected.name);
  expect(actual.alias).toBe(expected.alias);
  expect(actual.alertEnabled).toBe(expected.alertEnabled);
  expect(actual.carouselEnabled).toBe(expected.carouselEnabled);
  expect(actual.addedAt).toBe(expected.addedAt);

  if (expected.purchasePrice === undefined) {
    expect(actual.purchasePrice).toBeUndefined();
  } else {
    expect(actual.purchasePrice).toBeCloseTo(expected.purchasePrice, 5);
  }
  if (expected.targetPrice === undefined) {
    expect(actual.targetPrice).toBeUndefined();
  } else {
    expect(actual.targetPrice).toBeCloseTo(expected.targetPrice, 5);
  }
  if (expected.targetChangeRate === undefined) {
    expect(actual.targetChangeRate).toBeUndefined();
  } else {
    expect(actual.targetChangeRate).toBeCloseTo(expected.targetChangeRate, 5);
  }
}

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 5: 导出导入往返一致性', () => {

  test('任意股票列表经 exportJSON() 再 importJSON() 后，列表长度与每条数据完全一致', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueStockListArb, async (entries) => {
        // Step 1: 创建 StockManager 并添加股票
        const ctx = new MockExtensionContext();
        const manager = new StockManager(ctx as any);
        for (const entry of entries) {
          await manager.add(entry);
        }

        // Step 2: 导出 JSON
        const json = manager.exportJSON();

        // Step 3: 导入到新实例
        const ctx2 = new MockExtensionContext();
        const importer = new StockManager(ctx2 as any);
        await importer.importJSON(json);

        // Step 4: 验证导入后的列表与原始列表完全一致
        const imported = importer.getAll();
        expect(imported).toHaveLength(entries.length);

        // 按 code 建立索引，逐一比对字段
        const importedMap = new Map(imported.map(s => [s.code.toLowerCase(), s]));
        for (const original of entries) {
          const actual = importedMap.get(original.code.toLowerCase());
          expect(actual).toBeDefined();
          if (!actual) { return; }
          assertStockEntryEqual(actual, original);
        }
      }),
      { numRuns: 100 }
    );
  });

  test('单条股票经 exportJSON() 再 importJSON() 后，所有字段值完全一致', async () => {
    await fc.assert(
      fc.asyncProperty(stockEntryArb, async (entry) => {
        const ctx = new MockExtensionContext();
        const manager = new StockManager(ctx as any);
        await manager.add(entry);

        const json = manager.exportJSON();

        const ctx2 = new MockExtensionContext();
        const importer = new StockManager(ctx2 as any);
        await importer.importJSON(json);

        const imported = importer.getAll();
        expect(imported).toHaveLength(1);
        assertStockEntryEqual(imported[0], entry);
      }),
      { numRuns: 100 }
    );
  });

  // ─── 错误场景测试 ──────────────────────────────────────────────────────────

  test('导入格式错误的 JSON 应抛出异常', async () => {
    const ctx = new MockExtensionContext();
    const manager = new StockManager(ctx as any);

    const invalidJsonStrings = [
      '',
      'not json at all',
      '{broken json',
      '{"version":"1.0"}',           // 缺少 stocks 字段
      '{"stocks":[]}',               // 缺少 version 字段
      '"just a string"',             // 顶层不是对象
      '123',                         // 顶层是数字
    ];

    for (const invalid of invalidJsonStrings) {
      await expect(manager.importJSON(invalid)).rejects.toThrow();
    }
  });

  test('导入缺少必填字段的股票条目 JSON 应抛出异常', async () => {
    const ctx = new MockExtensionContext();
    const manager = new StockManager(ctx as any);

    // 缺少 code 字段
    const missingCode = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [{ name: '招商银行', alertEnabled: true, carouselEnabled: false, addedAt: 1000 }],
    });
    await expect(manager.importJSON(missingCode)).rejects.toThrow();

    // 缺少 name 字段
    const missingName = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [{ code: 'sh600036', alertEnabled: true, carouselEnabled: false, addedAt: 1000 }],
    });
    await expect(manager.importJSON(missingName)).rejects.toThrow();

    // 缺少 alertEnabled 字段
    const missingAlert = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [{ code: 'sh600036', name: '招商银行', carouselEnabled: false, addedAt: 1000 }],
    });
    await expect(manager.importJSON(missingAlert)).rejects.toThrow();

    // 缺少 carouselEnabled 字段
    const missingCarousel = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [{ code: 'sh600036', name: '招商银行', alertEnabled: true, addedAt: 1000 }],
    });
    await expect(manager.importJSON(missingCarousel)).rejects.toThrow();

    // 缺少 addedAt 字段
    const missingAddedAt = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [{ code: 'sh600036', name: '招商银行', alertEnabled: true, carouselEnabled: false }],
    });
    await expect(manager.importJSON(missingAddedAt)).rejects.toThrow();
  });

});
