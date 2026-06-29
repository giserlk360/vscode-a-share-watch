/**
 * StatusBarCarousel 单元测试
 * 验证轮播逻辑、显示格式、无数据隐藏等核心行为
 */

import { StatusBarCarousel } from '../../ui/StatusBarCarousel';
import { StockData, StockEntry } from '../../types';

jest.mock('vscode');
import * as vscode from 'vscode';

// ─── 测试数据工厂 ─────────────────────────────────────────────────────────────

function makeStock(code: string, name: string, changeRate: number, currentPrice = 10): StockData {
  return {
    code,
    name,
    currentPrice,
    openPrice: currentPrice,
    closePrice: currentPrice - (changeRate * currentPrice) / 100,
    changeAmount: (changeRate * currentPrice) / 100,
    changeRate,
    volume: 1000,
    isETF: false,
    timestamp: Date.now(),
  };
}

function makeEntry(code: string, carouselEnabled: boolean): StockEntry {
  return {
    code,
    name: code,
    carouselEnabled,
    addedAt: Date.now(),
  };
}

/** 创建一个新的 carousel 实例，并返回它对应的 statusBarItem mock */
function createCarousel(entries: StockEntry[] = []): {
  carousel: StatusBarCarousel;
  item: { text: string; tooltip: string; show: jest.Mock; hide: jest.Mock; dispose: jest.Mock };
} {
  const item = {
    text: '',
    tooltip: '',
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  };
  (vscode.window.createStatusBarItem as jest.Mock).mockReturnValueOnce(item);
  const carousel = new StatusBarCarousel(entries);
  return { carousel, item };
}

// ─── 测试套件 ─────────────────────────────────────────────────────────────────

describe('StatusBarCarousel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ─── 显示格式 ───────────────────────────────────────────────────────────────

  describe('显示格式', () => {
    it('上涨时显示 +号和两位小数', () => {
      const { carousel, item } = createCarousel([makeEntry('sh600036', true)]);
      carousel.updateData([makeStock('sh600036', '招商银行', 4.79)]);
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');
      carousel.dispose();
    });

    it('下跌时显示负号', () => {
      const { carousel, item } = createCarousel([makeEntry('sh600519', true)]);
      carousel.updateData([makeStock('sh600519', '贵州茅台', -1.23)]);
      expect(item.text).toBe('$(graph) 贵州茅台 -1.23%');
      carousel.dispose();
    });

    it('涨跌幅为 0 时显示 +0.00%', () => {
      const { carousel, item } = createCarousel([makeEntry('sh000001', true)]);
      carousel.updateData([makeStock('sh000001', '上证指数', 0)]);
      expect(item.text).toBe('$(graph) 上证指数 +0.00%');
      carousel.dispose();
    });
  });

  // ─── 无数据隐藏 ─────────────────────────────────────────────────────────────

  describe('无数据时隐藏状态栏', () => {
    it('无股票数据时调用 hide()', () => {
      const { carousel, item } = createCarousel([]);
      carousel.updateData([]);
      expect(item.hide).toHaveBeenCalled();
      expect(item.show).not.toHaveBeenCalled();
      carousel.dispose();
    });

    it('所有条目 carouselEnabled=false 时调用 hide()', () => {
      const { carousel, item } = createCarousel([makeEntry('sh600036', false)]);
      carousel.updateData([makeStock('sh600036', '招商银行', 4.79)]);
      expect(item.hide).toHaveBeenCalled();
      carousel.dispose();
    });

    it('有数据时调用 show()', () => {
      const { carousel, item } = createCarousel([makeEntry('sh600036', true)]);
      carousel.updateData([makeStock('sh600036', '招商银行', 4.79)]);
      expect(item.show).toHaveBeenCalled();
      carousel.dispose();
    });
  });

  // ─── carouselEnabled 过滤 ───────────────────────────────────────────────────

  describe('carouselEnabled 过滤', () => {
    it('只显示 carouselEnabled=true 的股票', () => {
      const { carousel, item } = createCarousel([
        makeEntry('sh600036', true),
        makeEntry('sh600519', false),
      ]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');
      carousel.dispose();
    });
  });

  // ─── 轮播切换逻辑 ───────────────────────────────────────────────────────────

  describe('轮播切换', () => {
    it('start() 后按间隔切换到下一只，并循环', () => {
      const { carousel, item } = createCarousel([
        makeEntry('sh600036', true),
        makeEntry('sh600519', true),
      ]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      carousel.setInterval(5);
      carousel.start();

      // 初始显示第 0 只
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');

      // 经过 5 秒后切换到第 1 只
      jest.advanceTimersByTime(5000);
      expect(item.text).toBe('$(graph) 贵州茅台 -1.23%');

      // 再经过 5 秒后循环回第 0 只
      jest.advanceTimersByTime(5000);
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');

      carousel.dispose();
    });

    it('stop() 后不再切换', () => {
      const { carousel, item } = createCarousel([
        makeEntry('sh600036', true),
        makeEntry('sh600519', true),
      ]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      carousel.setInterval(5);
      carousel.start();
      carousel.stop();

      const textAfterStop = item.text;
      jest.advanceTimersByTime(10000);
      expect(item.text).toBe(textAfterStop);
      carousel.dispose();
    });
  });

  // ─── setInterval ────────────────────────────────────────────────────────────

  describe('setInterval', () => {
    it('修改间隔后新间隔生效', () => {
      const { carousel, item } = createCarousel([
        makeEntry('sh600036', true),
        makeEntry('sh600519', true),
      ]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      // 先以默认间隔启动，再改为 3 秒
      carousel.start();
      carousel.setInterval(3);

      // 3 秒后应切换
      jest.advanceTimersByTime(3000);
      expect(item.text).toBe('$(graph) 贵州茅台 -1.23%');
      carousel.dispose();
    });
  });

  // ─── updateEntries ──────────────────────────────────────────────────────────

  describe('updateEntries', () => {
    it('更新条目后重置索引并重新渲染', () => {
      const { carousel, item } = createCarousel([makeEntry('sh600036', true)]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      // 初始只有招商银行参与轮播
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');

      // 更新条目，两只都参与
      carousel.updateEntries([
        makeEntry('sh600036', true),
        makeEntry('sh600519', true),
      ]);
      // 索引重置为 0，仍显示招商银行
      expect(item.text).toBe('$(graph) 招商银行 +4.79%');
      carousel.dispose();
    });
  });

  // ─── dispose ────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('dispose() 调用 statusBarItem.dispose()', () => {
      const { carousel, item } = createCarousel();
      carousel.dispose();
      expect(item.dispose).toHaveBeenCalled();
    });

    it('dispose() 后定时器停止', () => {
      const { carousel, item } = createCarousel([
        makeEntry('sh600036', true),
        makeEntry('sh600519', true),
      ]);
      carousel.updateData([
        makeStock('sh600036', '招商银行', 4.79),
        makeStock('sh600519', '贵州茅台', -1.23),
      ]);
      carousel.start();
      carousel.dispose();

      const textAfterDispose = item.text;
      jest.advanceTimersByTime(10000);
      expect(item.text).toBe(textAfterDispose);
    });
  });
});
