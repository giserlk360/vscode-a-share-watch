/**
 * StockManager 单元测试
 * 需求参考：2.5, 2.6, 2.7
 */

import { StockManager } from '../../data/StockManager';
import { StockEntry, STORAGE_KEYS } from '../../types';
import { MockExtensionContext } from '../__mocks__/vscode';

// ─── 辅助工厂 ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<StockEntry> = {}): StockEntry {
  return {
    code: 'sh600036',
    name: '招商银行',
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeManager(): StockManager {
  const ctx = new MockExtensionContext() as any;
  return new StockManager(ctx);
}

// ─── 增删改查基本流程 ─────────────────────────────────────────────────────────

describe('增删改查基本流程', () => {
  test('add 后 getAll 能返回该股票', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    const all = mgr.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].code).toBe('sh600036');
  });

  test('add 多条后 getAll 返回全部', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.add(makeEntry({ code: 'sz000001', name: '平安银行' }));
    expect(mgr.getAll()).toHaveLength(2);
  });

  test('remove 后 getAll 不再包含该股票', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.remove('sh600036');
    expect(mgr.getAll()).toHaveLength(0);
  });

  test('update 能修改 name 字段', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.update('sh600036', { name: '招行' });
    expect(mgr.getByCode('sh600036')!.name).toBe('招行');
  });

  test('update 能修改 alias 字段', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.update('sh600036', { alias: '招行' });
    expect(mgr.getByCode('sh600036')!.alias).toBe('招行');
  });

  test('getByCode 能找到已添加的股票', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sz000001', name: '平安银行' }));
    const found = mgr.getByCode('sz000001');
    expect(found).toBeDefined();
    expect(found!.name).toBe('平安银行');
  });

  test('getByCode 找不到时返回 undefined', async () => {
    const mgr = makeManager();
    expect(mgr.getByCode('sh999999')).toBeUndefined();
  });

  test('findByKeyword 按官方名称匹配', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    const found = mgr.findByKeyword('招商银行');
    expect(found).toBeDefined();
    expect(found!.code).toBe('sh600036');
  });
});

// ─── 代码有效性验证 ───────────────────────────────────────────────────────────

describe('代码有效性验证', () => {
  test('空字符串代码抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: '' }))).rejects.toThrow();
  });

  test('非6位纯数字代码抛出异常（5位）', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: '12345' }))).rejects.toThrow();
  });

  test('非6位纯数字代码抛出异常（7位）', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: '1234567' }))).rejects.toThrow();
  });

  test('含字母的代码抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: '60003a' }))).rejects.toThrow();
  });

  test('无效前缀的代码抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: 'bj600036' }))).rejects.toThrow();
  });

  test('有效的纯6位数字代码不抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: '600036' }))).resolves.not.toThrow();
  });

  test('有效的 sh 前缀代码不抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: 'sh600036' }))).resolves.not.toThrow();
  });

  test('有效的 sz 前缀代码不抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.add(makeEntry({ code: 'sz000001' }))).resolves.not.toThrow();
  });
});

// ─── 重复添加 ─────────────────────────────────────────────────────────────────

describe('重复添加', () => {
  test('添加已存在的代码抛出异常', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await expect(mgr.add(makeEntry({ code: 'sh600036', name: '招商银行2' }))).rejects.toThrow();
  });

  test('重复添加后列表数量不变', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    try {
      await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行2' }));
    } catch {
      // 预期抛出
    }
    expect(mgr.getAll()).toHaveLength(1);
  });
});

// ─── importJSON 格式错误 ──────────────────────────────────────────────────────

describe('importJSON 格式错误', () => {
  test('传入非法 JSON 字符串抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.importJSON('not json')).rejects.toThrow();
  });

  test('传入数组而非对象抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.importJSON('[]')).rejects.toThrow();
  });

  test('缺少 version 字段抛出异常', async () => {
    const mgr = makeManager();
    const bad = JSON.stringify({ stocks: [] });
    await expect(mgr.importJSON(bad)).rejects.toThrow();
  });

  test('缺少 stocks 字段抛出异常', async () => {
    const mgr = makeManager();
    const bad = JSON.stringify({ version: '1.0' });
    await expect(mgr.importJSON(bad)).rejects.toThrow();
  });

  test('stocks 中包含无效代码的条目抛出异常', async () => {
    const mgr = makeManager();
    const bad = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [
        { code: 'invalid', name: '测试', addedAt: Date.now() },
      ],
    });
    await expect(mgr.importJSON(bad)).rejects.toThrow();
  });

  test('stocks 中条目缺少必填字段抛出异常', async () => {
    const mgr = makeManager();
    const bad = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [
        { code: 'sh600036' }, // 缺少 name 等
      ],
    });
    await expect(mgr.importJSON(bad)).rejects.toThrow();
  });

  test('合法 JSON 导入成功后 getAll 返回正确数据', async () => {
    const mgr = makeManager();
    const entry = makeEntry({ code: 'sh600036', name: '招商银行' });
    const good = JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stocks: [entry],
    });
    await mgr.importJSON(good);
    expect(mgr.getAll()).toHaveLength(1);
    expect(mgr.getAll()[0].code).toBe('sh600036');
  });
});

// ─── findByKeyword 别名优先 ───────────────────────────────────────────────────

describe('findByKeyword 别名优先匹配', () => {
  test('别名匹配优先于官方名称', async () => {
    const mgr = makeManager();
    // 两条股票：一条官方名称为"招商银行"，另一条别名为"招商银行"
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行', alias: undefined }));
    await mgr.add(makeEntry({ code: 'sz000001', name: '平安银行', alias: '招商银行' }));

    const found = mgr.findByKeyword('招商银行');
    // 应优先返回别名匹配的 sz000001
    expect(found!.code).toBe('sz000001');
  });

  test('无别名时按官方名称匹配', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    const found = mgr.findByKeyword('招商银行');
    expect(found!.code).toBe('sh600036');
  });

  test('关键词不匹配时返回 undefined', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    expect(mgr.findByKeyword('不存在的名称')).toBeUndefined();
  });

  test('空关键词返回 undefined', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    expect(mgr.findByKeyword('')).toBeUndefined();
  });

  test('匹配忽略大小写', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: 'CMB', alias: 'cmb' }));
    expect(mgr.findByKeyword('CMB')).toBeDefined();
  });
});

// ─── update 不允许修改 code ───────────────────────────────────────────────────

describe('update 不允许修改 code', () => {
  test('patch 中包含 code 字段时，code 不被修改', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.update('sh600036', { code: 'sh999999', name: '新名称' } as any);
    const entry = mgr.getByCode('sh600036');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe('sh600036');
    // 其他字段正常更新
    expect(entry!.name).toBe('新名称');
  });

  test('update 不存在的代码抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.update('sh999999', { name: '不存在' })).rejects.toThrow();
  });
});

// ─── remove 幂等 ──────────────────────────────────────────────────────────────

describe('remove 幂等', () => {
  test('删除不存在的代码不抛出异常', async () => {
    const mgr = makeManager();
    await expect(mgr.remove('sh999999')).resolves.not.toThrow();
  });

  test('重复删除同一代码不抛出异常', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.remove('sh600036');
    await expect(mgr.remove('sh600036')).resolves.not.toThrow();
  });

  test('删除后列表为空', async () => {
    const mgr = makeManager();
    await mgr.add(makeEntry({ code: 'sh600036', name: '招商银行' }));
    await mgr.remove('sh600036');
    expect(mgr.getAll()).toHaveLength(0);
  });
});

describe('tomorrow plan memo', () => {
  test('savePlanMemo persists plain text', async () => {
    const mgr = makeManager();

    await mgr.savePlanMemo('明天观察招商银行\n低开再看');

    expect(mgr.getPlanMemo()).toBe('明天观察招商银行\n低开再看');
  });

  test('loads existing memo from storage', async () => {
    const ctx = new MockExtensionContext() as any;
    await ctx.globalState.update(STORAGE_KEYS.PLAN, '已有计划');

    const mgr = new StockManager(ctx);
    expect(mgr.getPlanMemo()).toBe('已有计划');
  });
});
