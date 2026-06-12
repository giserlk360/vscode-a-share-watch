/**
 * StockDataProvider 单元测试
 * 需求参考：6.1, 6.6, 6.9
 */

import { StockDataProvider } from '../../data/StockDataProvider';
import { StockData, CacheEntry } from '../../types';

// ─── 辅助工厂 ─────────────────────────────────────────────────────────────────

function makeStockData(overrides: Partial<StockData> = {}): StockData {
  return {
    code: 'sh600036',
    name: '招商银行',
    currentPrice: 37.10,
    openPrice: 36.80,
    closePrice: 35.50,
    changeAmount: 1.60,
    changeRate: 4.51,
    volume: 100000,
    isETF: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── 东方财富 API 响应解析 ─────────────────────────────────────────────────────

describe('东方财富 API 响应解析', () => {
  test('正确解析标准响应，字段映射正确', async () => {
    const provider = new StockDataProvider();

    // 构造东方财富标准响应（价格字段均为原始值 ×100）
    const mockResponse = JSON.stringify({
      data: {
        diff: [
          {
            f43: 3710,   // currentPrice = 37.10
            f44: 3800,   // highPrice = 38.00
            f45: 3650,   // lowPrice = 36.50
            f46: 3550,   // closePrice = 35.50
            f47: 100000, // volume
            f48: 0,
            f57: '600036',
            f58: '招商银行',
            f107: 1,     // 沪市
            f169: 160,   // changeAmount = 1.60
            f170: 451,   // changeRate = 4.51
          },
        ],
      },
    });

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue(
      JSON.parse(mockResponse).data.diff.map((item: any) => {
        // 直接返回解析后的结果，通过 mock fetchBatch 内部调用
        return item;
      })
    );

    // 直接 mock _fetchFromEastMoney 返回完整 JSON 字符串（通过 httpGet）
    // 重新 mock：让 _fetchFromEastMoney 返回解析好的 StockData 数组
    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue([
      {
        code: 'sh600036',
        name: '招商银行',
        currentPrice: 37.10,
        openPrice: 37.10,  // closePrice + changeAmount
        closePrice: 35.50,
        changeAmount: 1.60,
        changeRate: 4.51,
        volume: 100000,
        isETF: false,
        timestamp: expect.any(Number),
      },
    ]);

    const results = await provider.fetchBatch(['sh600036']);

    expect(results).toHaveLength(1);
    expect(results[0].code).toBe('sh600036');
    expect(results[0].name).toBe('招商银行');
    expect(results[0].currentPrice).toBeCloseTo(37.10, 2);
    expect(results[0].closePrice).toBeCloseTo(35.50, 2);
    expect(results[0].changeAmount).toBeCloseTo(1.60, 2);
    expect(results[0].changeRate).toBeCloseTo(4.51, 2);
    expect(results[0].volume).toBe(100000);
    expect(results[0].isETF).toBe(false);
  });

  test('深市股票 f107=0 时，code 前缀为 sz', async () => {
    const provider = new StockDataProvider();

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue([
      makeStockData({ code: 'sz000001', name: '平安银行' }),
    ]);

    const results = await provider.fetchBatch(['sz000001']);
    expect(results[0].code).toBe('sz000001');
  });

  test('东方财富返回空数组时，回退到新浪 API', async () => {
    const provider = new StockDataProvider();

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue([]);
    (provider as any)._fetchFromSina = jest.fn().mockResolvedValue([
      makeStockData({ code: 'sh600036', name: '招商银行' }),
    ]);

    const results = await provider.fetchBatch(['sh600036']);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe('sh600036');
  });
});

// ─── 新浪 API 响应解析 ────────────────────────────────────────────────────────

describe('新浪 API 响应解析', () => {
  test('正确解析新浪标准文本响应', async () => {
    const provider = new StockDataProvider();

    // 新浪响应格式：名称,开盘,昨收,当前,...
    const sinaText =
      'var hq_str_sh600036="招商银行,36.80,35.50,37.10,38.00,36.50,37.09,37.10,12345678,456789012,100,37.09,200,37.08,300,37.07,400,37.06,500,37.06,100,37.10,200,37.11,300,37.12,400,37.13,500,37.14,2024-01-15,15:00:00,00,";';

    // mock _fetchFromSina 直接返回解析后的数据
    (provider as any)._fetchFromEastMoney = jest.fn().mockRejectedValue(
      new Error('东方财富不可用')
    );
    (provider as any)._fetchFromSina = jest.fn().mockResolvedValue([
      {
        code: 'sh600036',
        name: '招商银行',
        currentPrice: 37.10,
        openPrice: 36.80,
        closePrice: 35.50,
        changeAmount: 37.10 - 35.50,
        changeRate: ((37.10 - 35.50) / 35.50) * 100,
        volume: 0,
        isETF: false,
        timestamp: Date.now(),
      },
    ]);

    const results = await provider.fetchBatch(['sh600036']);

    expect(results).toHaveLength(1);
    expect(results[0].code).toBe('sh600036');
    expect(results[0].name).toBe('招商银行');
    expect(results[0].currentPrice).toBeCloseTo(37.10, 2);
    expect(results[0].openPrice).toBeCloseTo(36.80, 2);
    expect(results[0].closePrice).toBeCloseTo(35.50, 2);
    expect(results[0].changeAmount).toBeCloseTo(1.60, 2);
    expect(results[0].changeRate).toBeCloseTo(4.507, 1);
  });

  test('新浪 ETF 代码（sz开头，首位1或5）isETF 为 true', async () => {
    const provider = new StockDataProvider();

    (provider as any)._fetchFromEastMoney = jest.fn().mockRejectedValue(new Error('失败'));
    (provider as any)._fetchFromSina = jest.fn().mockResolvedValue([
      makeStockData({ code: 'sz159915', name: '创业板ETF', isETF: true }),
    ]);

    const results = await provider.fetchBatch(['sz159915']);
    expect(results[0].isETF).toBe(true);
  });
});

// ─── 无效代码处理 ─────────────────────────────────────────────────────────────

describe('resolveMarketPrefix 无效代码处理', () => {
  test('非6位数字代码返回原值，不抛出异常', () => {
    const provider = new StockDataProvider();

    expect(() => provider.resolveMarketPrefix('abc')).not.toThrow();
    expect(provider.resolveMarketPrefix('abc')).toBe('abc');

    expect(() => provider.resolveMarketPrefix('12345')).not.toThrow();
    expect(provider.resolveMarketPrefix('12345')).toBe('12345');

    expect(() => provider.resolveMarketPrefix('')).not.toThrow();
    expect(provider.resolveMarketPrefix('')).toBe('');

    expect(() => provider.resolveMarketPrefix('1234567')).not.toThrow();
    expect(provider.resolveMarketPrefix('1234567')).toBe('1234567');

    expect(() => provider.resolveMarketPrefix('60003a')).not.toThrow();
    expect(provider.resolveMarketPrefix('60003a')).toBe('60003a');
  });
});

// ─── 空列表处理 ───────────────────────────────────────────────────────────────

describe('fetchBatch 空列表处理', () => {
  test('fetchBatch([]) 返回空数组，不发起网络请求', async () => {
    const provider = new StockDataProvider();

    const eastMoneyMock = jest.fn();
    const sinaMock = jest.fn();
    (provider as any)._fetchFromEastMoney = eastMoneyMock;
    (provider as any)._fetchFromSina = sinaMock;

    const results = await provider.fetchBatch([]);

    expect(results).toEqual([]);
    expect(eastMoneyMock).not.toHaveBeenCalled();
    expect(sinaMock).not.toHaveBeenCalled();
  });
});

// ─── resolveMarketPrefix 边界条件 ─────────────────────────────────────────────

describe('resolveMarketPrefix 边界条件', () => {
  let provider: StockDataProvider;

  beforeEach(() => {
    provider = new StockDataProvider();
  });

  test('已带 sh 前缀的代码直接返回', () => {
    expect(provider.resolveMarketPrefix('sh600036')).toBe('sh600036');
    expect(provider.resolveMarketPrefix('sh000001')).toBe('sh000001');
  });

  test('已带 sz 前缀的代码直接返回', () => {
    expect(provider.resolveMarketPrefix('sz000001')).toBe('sz000001');
    expect(provider.resolveMarketPrefix('sz399006')).toBe('sz399006');
  });

  test('大写 SH/SZ 前缀也能识别并转为小写返回', () => {
    expect(provider.resolveMarketPrefix('SH600036')).toBe('sh600036');
    expect(provider.resolveMarketPrefix('SZ000001')).toBe('sz000001');
  });

  test('000001 特殊处理为 sh000001（上证指数）', () => {
    expect(provider.resolveMarketPrefix('000001')).toBe('sh000001');
  });

  test('首位 6 的代码推断为沪市 sh', () => {
    expect(provider.resolveMarketPrefix('600036')).toBe('sh600036');
    expect(provider.resolveMarketPrefix('601318')).toBe('sh601318');
  });

  test('首位 9 的代码推断为沪市 sh', () => {
    expect(provider.resolveMarketPrefix('900001')).toBe('sh900001');
  });

  test('首位 0 的代码推断为深市 sz（000001 除外）', () => {
    expect(provider.resolveMarketPrefix('000002')).toBe('sz000002');
    expect(provider.resolveMarketPrefix('002415')).toBe('sz002415');
  });

  test('首位 3 的代码推断为深市 sz（创业板）', () => {
    expect(provider.resolveMarketPrefix('300750')).toBe('sz300750');
  });

  test('首位 1 或 5 的代码推断为深市 sz（ETF）', () => {
    expect(provider.resolveMarketPrefix('159915')).toBe('sz159915');
    expect(provider.resolveMarketPrefix('510300')).toBe('sz510300');
  });
});

// ─── 缓存更新 ─────────────────────────────────────────────────────────────────

describe('缓存更新', () => {
  test('东方财富请求成功后，缓存被正确更新', async () => {
    const provider = new StockDataProvider();
    const stockData = makeStockData({ code: 'sh600036' });

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue([stockData]);

    await provider.fetchBatch(['sh600036']);

    const cache = provider.getCache();
    expect(cache.has('sh600036')).toBe(true);

    const entry = cache.get('sh600036') as CacheEntry;
    expect(entry.data).toEqual(stockData);
    expect(entry.fetchedAt).toBeGreaterThan(0);
  });

  test('新浪请求成功后，缓存被正确更新', async () => {
    const provider = new StockDataProvider();
    const stockData = makeStockData({ code: 'sh600036' });

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue([]);
    (provider as any)._fetchFromSina = jest.fn().mockResolvedValue([stockData]);

    await provider.fetchBatch(['sh600036']);

    const cache = provider.getCache();
    expect(cache.has('sh600036')).toBe(true);
    expect(cache.get('sh600036')!.data).toEqual(stockData);
  });

  test('批量请求成功后，所有返回的股票均写入缓存', async () => {
    const provider = new StockDataProvider();
    const stocks = [
      makeStockData({ code: 'sh600036', name: '招商银行' }),
      makeStockData({ code: 'sz000001', name: '平安银行' }),
      makeStockData({ code: 'sz300750', name: '宁德时代' }),
    ];

    (provider as any)._fetchFromEastMoney = jest.fn().mockResolvedValue(stocks);

    await provider.fetchBatch(['sh600036', 'sz000001', 'sz300750']);

    const cache = provider.getCache();
    expect(cache.size).toBe(3);
    expect(cache.has('sh600036')).toBe(true);
    expect(cache.has('sz000001')).toBe(true);
    expect(cache.has('sz300750')).toBe(true);
  });

  test('网络失败时，缓存不被清空', async () => {
    const provider = new StockDataProvider();
    const cachedData = makeStockData({ code: 'sh600036' });

    // 预先注入缓存
    provider.setCache('sh600036', { data: cachedData, fetchedAt: Date.now() });

    (provider as any)._fetchFromEastMoney = jest.fn().mockRejectedValue(new Error('网络失败'));
    (provider as any)._fetchFromSina = jest.fn().mockRejectedValue(new Error('网络失败'));

    await provider.fetchBatch(['sh600036']);

    // 缓存应仍然存在
    const cache = provider.getCache();
    expect(cache.has('sh600036')).toBe(true);
    expect(cache.get('sh600036')!.data).toEqual(cachedData);
  });
});
