import { PriceMonitor } from '../../business/PriceMonitor';
import { StockManager } from '../../data/StockManager';
import { IStockDataProvider } from '../../data/StockDataProvider';
import { KlineDay } from '../../types';
import { MockExtensionContext } from '../__mocks__/vscode';

function makeKline(closes: number[]): KlineDay[] {
  return closes.map((close, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    open: close,
    close,
    high: close,
    low: close,
    volume: 0,
  }));
}

function makeMonitor(): PriceMonitor {
  const provider: IStockDataProvider = {
    fetchBatch: jest.fn().mockResolvedValue([]),
    fetchSingle: jest.fn().mockResolvedValue(null),
    resolveCode: jest.fn().mockResolvedValue(null),
    resolveMarketPrefix: jest.fn(code => code),
    fetchKline: jest.fn().mockResolvedValue([]),
  };
  const ctx = new MockExtensionContext() as any;
  return new PriceMonitor(provider, new StockManager(ctx), ctx);
}

describe('auto wishlist trend detection', () => {
  test('matches four consecutive down days', () => {
    const monitor = makeMonitor() as any;

    const reason = monitor._getWishlistTrendReason(makeKline([10, 9.8, 9.5, 9.2, 9]));

    expect(reason).toContain('连续下跌');
  });

  test('matches more than 15 percent drop in recent five days', () => {
    const monitor = makeMonitor() as any;

    const reason = monitor._getWishlistTrendReason(makeKline([10, 10.2, 9.8, 9.1, 8.4]));

    expect(reason).toContain('近5日跌幅');
  });

  test('ignores normal pullbacks', () => {
    const monitor = makeMonitor() as any;

    const reason = monitor._getWishlistTrendReason(makeKline([10, 9.9, 10.1, 9.8, 9.7]));

    expect(reason).toBeNull();
  });
});
