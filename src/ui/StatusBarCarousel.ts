/**
 * StatusBarCarousel — 状态栏轮播组件
 *
 * 在 VSCode 状态栏按设定间隔轮播显示股票行情。
 * 只轮播 carouselEnabled = true 的股票条目。
 *
 * 需求: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import * as vscode from 'vscode';
import { StockData, StockEntry, CarouselDisplayOptions, PluginSettings } from '../types';

export class StatusBarCarousel {
  private statusBarItem: vscode.StatusBarItem;
  private currentIndex: number = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number = 5000;
  private stockDataList: StockData[] = [];
  private entries: StockEntry[] = [];
  private settings: PluginSettings | null = null;
  private displayOptions: CarouselDisplayOptions = {
    showChangeRate: true,
    showChangeAmount: false,
    showPositionProfit: false,
    showDailyProfit: false,
    showAlias: true,
  };

  /**
   * @param entries 初始股票条目列表，用于过滤 carouselEnabled=true 的股票
   */
  constructor(entries: StockEntry[] = []) {
    this.entries = entries;
    // 创建状态栏项，优先级 100，显示在左侧
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
  }

  /**
   * 启动轮播定时器
   * 若已在运行则先停止再重新启动
   */
  public start(): void {
    this.stop();
    // 立即显示当前项
    this.render();
    this.timer = setInterval(() => {
      this.advance();
    }, this.intervalMs);
  }

  /**
   * 停止轮播定时器
   */
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 设置轮播间隔
   * 若轮播正在运行，会重启定时器使新间隔立即生效
   * @param seconds 间隔秒数
   */
  public setInterval(seconds: number): void {
    this.intervalMs = seconds * 1000;
    // 若当前正在运行，重启以应用新间隔
    if (this.timer !== null) {
      this.start();
    }
  }

  /**
   * 更新轮播数据
   * 由 PriceMonitor 在每次刷新后调用
   * @param stocks 最新股票实时数据列表
   */
  public updateData(stocks: StockData[]): void {
    this.stockDataList = stocks;
    // 数据更新后立即刷新当前显示
    this.render();
  }

  /**
   * 更新股票条目（用于过滤 carouselEnabled）
   * 当用户在设置中修改轮播开关时调用
   * @param entries 最新股票条目列表
   */
  public updateEntries(entries: StockEntry[]): void {
    this.entries = entries;
    this.currentIndex = 0;
    this.render();
  }

  /** 更新轮播显示选项 */
  public updateDisplayOptions(options: CarouselDisplayOptions): void {
    this.displayOptions = { ...options };
    this.render();
  }

  /** 更新插件设置（用于获取 carouselKeywords） */
  public updateSettings(settings: PluginSettings): void {
    this.settings = settings;
    this.render();
  }

  /**
   * 释放资源
   * 停止定时器并销毁状态栏项
   */
  public dispose(): void {
    this.stop();
    this.statusBarItem.dispose();
  }

  // ─── 私有方法 ────────────────────────────────────────────────────────────────

  /**
   * 获取当前需要轮播的股票列表
   * 取 carouselEnabled=true 的条目与实时数据的交集
   */
  private getCarouselStocks(): StockData[] {
    // 收集所有 carouselEnabled=true 的股票代码
    const enabledCodes = new Set(
      this.entries
        .filter((e) => e.carouselEnabled)
        .map((e) => e.code),
    );

    // 收集启用了轮播的特殊词汇对应的代码
    if (this.settings?.carouselKeywords) {
      const customKeywords = this.settings.customKeywords || {};
      for (const [keyword, enabled] of Object.entries(this.settings.carouselKeywords)) {
        if (enabled && customKeywords[keyword]) {
          enabledCodes.add(customKeywords[keyword]);
        }
      }
    }

    // 从实时数据中筛选出启用轮播的股票，保持顺序
    return this.stockDataList.filter((s) => enabledCodes.has(s.code));
  }

  /**
   * 切换到下一只股票
   * currentIndex = (currentIndex + 1) % stocks.length
   */
  private advance(): void {
    const stocks = this.getCarouselStocks();
    if (stocks.length === 0) {
      this.statusBarItem.hide();
      return;
    }
    this.currentIndex = (this.currentIndex + 1) % stocks.length;
    this.render();
  }

  /**
   * 渲染当前轮播项到状态栏
   * 格式：$(graph) {名称} {+/-}{涨跌幅}%
   * 无数据时隐藏状态栏项
   */
  private render(): void {
    const stocks = this.getCarouselStocks();

    if (stocks.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    if (this.currentIndex >= stocks.length) {
      this.currentIndex = 0;
    }

    const stock = stocks[this.currentIndex];
    const entry = this.entries.find(e => e.code === stock.code);
    const d = this.displayOptions;
    const decimals = stock.isETF ? 3 : 2;

    // 名称：优先显示别名（持仓别名 > 特殊词汇别名 > 官方名称）
    let name = stock.name;
    if (d.showAlias) {
      if (entry?.alias) {
        name = entry.alias;
      } else if (this.settings?.customKeywords) {
        // 反查特殊词汇别名：找到 code 对应的所有关键词名称
        const kwEntries = Object.entries(this.settings.customKeywords);
        // 默认原名列表
        const defaultNames = ['上证指数', '深证成指', '创业板指', '沪深300', '科创50'];
        // 优先找用户自定义别名（非默认原名）
        const userAlias = kwEntries.find(([k, v]) => v === stock.code && !defaultNames.includes(k));
        if (userAlias) {
          name = userAlias[0];
        }
      }
    }

    const parts: string[] = [name];

    if (d.showChangeRate) {
      const sign = stock.changeRate >= 0 ? '+' : '';
      parts.push(`${sign}${stock.changeRate.toFixed(decimals)}%`);
    }

    if (d.showChangeAmount) {
      const sign = stock.changeAmount >= 0 ? '+' : '';
      parts.push(`${sign}${stock.changeAmount.toFixed(decimals)}`);
    }

    if (d.showPositionProfit && entry?.purchasePrice && entry.purchasePrice > 0 && entry.shares && entry.shares > 0) {
      const profit = (stock.currentPrice - entry.purchasePrice) * entry.shares;
      const sign = profit >= 0 ? '+' : '-';
      parts.push(`${sign}${Math.abs(profit).toFixed(2)}`);
    }

    if (d.showDailyProfit && entry?.shares && entry.shares > 0 && stock.closePrice > 0) {
      const dailyProfit = (stock.currentPrice - stock.closePrice) * entry.shares;
      const sign = dailyProfit >= 0 ? '+' : '-';
      parts.push(`今${sign}${Math.abs(dailyProfit).toFixed(2)}`);
    }

    this.statusBarItem.text = `$(graph) ${parts.join(' ')}`;
    this.statusBarItem.tooltip = `${stock.code}  当前价：${stock.currentPrice.toFixed(decimals)}`;
    this.statusBarItem.show();
  }
}
