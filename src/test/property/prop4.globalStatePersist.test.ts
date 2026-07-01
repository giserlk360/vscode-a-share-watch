// Feature: vscode-stock-monitor, Property 4: 配置持久化往返一致性

/**
 * 属性测试：配置持久化往返一致性
 * Validates: Requirements 2.9, 7.2, 7.3, 7.4, 7.5
 *
 * 属性描述：
 * 对于任意股票列表或插件设置对象，将其写入 globalState 后再读取，
 * 应得到与原始数据字段值完全相同的对象。
 *
 * 测试策略：
 * 1. 创建 mock 的 vscode.ExtensionContext（使用 Map 模拟 globalState）
 * 2. 通过 StockManager.add() 写入股票数据
 * 3. 创建新的 StockManager 实例（从同一个 mock globalState 读取）
 * 4. 验证读取到的数据与写入的数据完全一致
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
  purchasePrice: fc.option(fc.float({ min: Math.fround(0.01), max: Math.fround(9999), noNaN: true }), { nil: undefined }),
  addedAt: fc.integer({ min: 0, max: Date.now() }),
});

/**
 * 生成一组代码唯一的 StockEntry 列表
 * 使用 uniqueArray 确保 code 字段不重复
 */
const uniqueStockListArb: fc.Arbitrary<StockEntry[]> = fc
  .uniqueArray(stockEntryArb, {
    selector: entry => entry.code.toLowerCase(),
    minLength: 1,
    maxLength: 10,
  });

// ─── 属性测试 ─────────────────────────────────────────────────────────────────

describe('Property 4: 配置持久化往返一致性', () => {

  test('单条股票写入 globalState 后，新实例读取结果与原始数据完全一致', async () => {
    await fc.assert(
      fc.asyncProperty(stockEntryArb, async (entry) => {
        const ctx = new MockExtensionContext();

        // 写入
        const writer = new StockManager(ctx as any);
        await writer.add(entry);

        // 用同一个 ctx 创建新实例（模拟重启后从持久化存储读取）
        const reader = new StockManager(ctx as any);
        const all = reader.getAll();

        expect(all).toHaveLength(1);
        const stored = all[0];

        // 验证所有字段完全一致
        expect(stored.code).toBe(entry.code);
        expect(stored.name).toBe(entry.name);
        expect(stored.alias).toBe(entry.alias);
        expect(stored.addedAt).toBe(entry.addedAt);

        // 可选数值字段：若原始值为 undefined 则存储也应为 undefined，否则值相等
        if (entry.purchasePrice === undefined) {
          expect(stored.purchasePrice).toBeUndefined();
        } else {
          expect(stored.purchasePrice).toBeCloseTo(entry.purchasePrice, 5);
        }
      }),
      { numRuns: 100 }
    );
  });

  test('多条股票写入 globalState 后，新实例读取的列表长度和每条数据均与原始一致', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueStockListArb, async (entries) => {
        const ctx = new MockExtensionContext();
        const writer = new StockManager(ctx as any);

        // 依次写入所有股票
        for (const entry of entries) {
          await writer.add(entry);
        }

        // 新实例读取
        const reader = new StockManager(ctx as any);
        const stored = reader.getAll();

        // 数量一致
        expect(stored).toHaveLength(entries.length);

        // 按 code 建立索引，逐一比对字段
        const storedMap = new Map(stored.map(s => [s.code.toLowerCase(), s]));
        for (const original of entries) {
          const s = storedMap.get(original.code.toLowerCase());
          expect(s).toBeDefined();
          if (!s) { return; }

          expect(s.code).toBe(original.code);
          expect(s.name).toBe(original.name);
          expect(s.alias).toBe(original.alias);
          expect(s.addedAt).toBe(original.addedAt);

          if (original.purchasePrice === undefined) {
            expect(s.purchasePrice).toBeUndefined();
          } else {
            expect(s.purchasePrice).toBeCloseTo(original.purchasePrice, 5);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  test('写入后删除某条股票，新实例读取时该股票不存在', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueStockListArb, async (entries) => {
        if (entries.length < 2) { return; } // 至少需要2条才有意义

        const ctx = new MockExtensionContext();
        const writer = new StockManager(ctx as any);

        for (const entry of entries) {
          await writer.add(entry);
        }

        // 删除第一条
        const removedCode = entries[0].code;
        await writer.remove(removedCode);

        // 新实例读取
        const reader = new StockManager(ctx as any);
        const stored = reader.getAll();

        // 数量减少1
        expect(stored).toHaveLength(entries.length - 1);
        // 被删除的 code 不存在
        expect(stored.find(s => s.code.toLowerCase() === removedCode.toLowerCase())).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

});
