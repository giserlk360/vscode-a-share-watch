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
    fetchMinute: jest.fn().mockResolvedValue([]),
    fetchMarketBreadth: jest.fn().mockResolvedValue({ up: 0, flat: 0, down: 0 }),
  };
  const ctx = new MockExtensionContext() as any;
  return new PriceMonitor(provider, new StockManager(ctx), ctx);
}

describe('pullback scoring', () => {
  const evaluate = (closes: number[]) => (makeMonitor() as any)._getWishlistTrendReason(makeKline(closes));

  test('deep crash scores high and qualifies', () => {
    const r = evaluate([10, 10.2, 10.1, 10.3, 10.5, 10.4, 10.1, 9.6, 9.1, 8.6, 8.2]);

    expect(r).not.toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.reason).toContain('高点回撤');
  });

  test('uptrend pullback with corroboration qualifies', () => {
    const r = evaluate([10, 10.5, 11, 11.5, 12, 12.2, 12.5, 11.9, 11.3, 11.05, 10.9]);

    expect(r).not.toBeNull();
    expect(r.reason).toContain('高点回撤');
  });

  test('sharp five-day drop qualifies', () => {
    const r = evaluate([10, 10, 10, 10, 10, 10.3, 10.2, 10.1, 10.0, 9.9, 9.4]);

    expect(r).not.toBeNull();
    expect(r.reason).toContain('近5日');
  });

  test('single strong streak alone does not qualify', () => {
    // 连续下跌6天=2分，无其他维度印证，低于3分门槛
    const r = evaluate([10, 10.1, 10.05, 10.1, 10.2, 10.15, 10.1, 10.0, 9.85, 9.7, 9.55]);

    expect(r).toBeNull();
  });

  test('grinding decline with mild drawdown does not qualify', () => {
    // 回撤1分 + 阴跌1分 = 2分，低于3分门槛
    const r = evaluate([10, 9.9, 9.85, 9.9, 9.65, 9.6, 9.65, 9.3, 9.35, 9.0, 8.95]);

    expect(r).toBeNull();
  });

  test('single mild condition does not qualify', () => {
    // 仅"近10日6天下跌"一个温和信号（1分）
    const r = evaluate([10, 9.9, 9.95, 9.85, 9.9, 9.8, 9.82, 9.7, 9.75, 9.65, 9.6]);

    expect(r).toBeNull();
  });

  test('ignores normal fluctuations and recovered declines', () => {
    expect(evaluate([10, 10.05, 9.95, 10.1, 10.0, 10.15, 10.05, 10.1, 10.0, 10.05, 9.95])).toBeNull();
    // 前4天连跌后明显反弹：尾部不再连跌、各窗口跌幅与回撤均不达标
    expect(evaluate([10, 9.8, 9.6, 9.4, 9.2, 9.5, 9.9, 10.1, 10.3, 10.5, 10.4])).toBeNull();
  });
});
