/**
 * PriceMonitor - 价格监控调度器
 * 负责定时拉取股票数据，并将结果分发给各 UI 组件
 *
 * 需求参考：6.5, 7.4
 */

import * as vscode from 'vscode';
import { PluginSettings, StockData, StockEntry, KlineDay, DEFAULT_SETTINGS, STORAGE_KEYS } from '../types';
import { IStockDataProvider } from '../data/StockDataProvider';
import { IStockManager } from '../data/StockManager';

const AUTO_WISHLIST_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_WISHLIST_KLINE_DAYS = 6;
const AUTO_WISHLIST_DROP_THRESHOLD = -15;
const AUTO_WISHLIST_CONSECUTIVE_DOWN_DAYS = 4;

// ─── 依赖接口（避免循环依赖，通过注册方法注入） ────────────────────────────────

/**
 * CommentDecorator 的最小接口
 * PriceMonitor 只需触发装饰更新，无需了解其内部实现
 */
export interface ICommentDecorator {
  /** 触发所有打开编辑器的注释装饰刷新 */
  triggerUpdate(stocks: StockData[], entries?: import('../types').StockEntry[], settings?: import('../types').PluginSettings): void;
  /** 收集当前编辑器注释中出现的股票代码 */
  collectCommentCodes?(): string[];
}

// ─── IPriceMonitor 接口 ───────────────────────────────────────────────────────

export interface IPriceMonitor {
  /** 启动定时刷新 */
  start(): void;
  /** 停止定时刷新 */
  stop(): void;
  /** 动态修改刷新间隔（秒） */
  setRefreshInterval(seconds: number): void;
  /** 更新部分设置并持久化 */
  updateSettings(patch: Partial<PluginSettings>): Promise<void>;
  /** 获取当前设置 */
  getSettings(): PluginSettings;
  /** 释放所有资源 */
  dispose(): void;
}

// ─── PriceMonitor 主类 ────────────────────────────────────────────────────────

export class PriceMonitor implements IPriceMonitor {
  /** 当前插件设置 */
  private settings: PluginSettings;

  /** 定时器句柄，null 表示未启动 */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 已注册的装饰器列表（支持多个，如 CommentDecorator + WebviewView） */
  private decorators: ICommentDecorator[] = [];

  /** 上次根据走势自动加入预购股的扫描时间 */
  private lastAutoWishlistScanAt = 0;

  /**
   * 构造函数
   * @param dataProvider 股票数据提供者（负责 API 请求）
   * @param stockManager 股票管理器（提供监控列表）
   * @param context VSCode 扩展上下文（用于 globalState 持久化）
   */
  constructor(
    private readonly dataProvider: IStockDataProvider,
    private readonly stockManager: IStockManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    // 从 globalState 加载已持久化的设置，不存在时使用默认值
    this.settings = this._loadSettings();
  }

  // ── 依赖注册方法（避免循环依赖） ──────────────────────────────────────────────

  /**
   * 注册装饰器（支持多个）
   */
  registerDecorator(decorator: ICommentDecorator): void {
    this.decorators.push(decorator);
  }

  // ── IPriceMonitor 实现 ────────────────────────────────────────────────────────

  /**
   * 启动定时刷新
   * 立即执行一次，然后按 refreshInterval 定时执行
   */
  start(): void {
    if (this.timer !== null) {
      // 已在运行，先停止旧定时器
      this.stop();
    }

    // 立即执行一次，确保启动后马上有数据
    this._refresh().catch(err => {
      console.error('[PriceMonitor] 首次刷新失败:', err);
    });

    // 启动定时器
    const intervalMs = this.settings.refreshInterval * 1000;
    this.timer = setInterval(() => {
      this._refresh().catch(err => {
        console.error('[PriceMonitor] 定时刷新失败:', err);
      });
    }, intervalMs);

    console.log(`[PriceMonitor] 已启动，刷新间隔: ${this.settings.refreshInterval}s`);
  }

  /**
   * 停止定时刷新
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[PriceMonitor] 已停止');
    }
  }

  /**
   * 动态修改刷新间隔（秒）
   * 若当前正在运行，则重启定时器使新间隔立即生效
   * @param seconds 新的刷新间隔（秒），最小值为 1
   */
  setRefreshInterval(seconds: number): void {
    const safeSeconds = Math.max(1, Math.floor(seconds));
    this.settings = { ...this.settings, refreshInterval: safeSeconds };

    // 若定时器正在运行，重启以应用新间隔
    if (this.timer !== null) {
      this.stop();
      this.start();
    }
  }

  /**
   * 更新部分设置并持久化到 globalState
   * @param patch 要更新的设置字段（部分更新）
   */
  async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };

    // 持久化到 globalState
    await this._saveSettings();

    // 若修改了刷新间隔且定时器正在运行，重启定时器
    if (patch.refreshInterval !== undefined && this.timer !== null) {
      this.stop();
      this.start();
    }
  }

  /**
   * 获取当前设置（返回副本，防止外部直接修改）
   */
  getSettings(): PluginSettings {
    return { ...this.settings };
  }

  /**
   * 释放所有资源
   * 停止定时器，清空依赖引用
   */
  dispose(): void {
    this.stop();
    this.decorators = [];
    console.log('[PriceMonitor] 已释放资源');
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────────────

  /**
   * 执行一次数据刷新
   * 1. 从 StockManager 获取当前监控的股票代码列表
   * 2. 调用 StockDataProvider.fetchBatch() 批量拉取数据
   * 3. 将结果分发给各已注册的组件
   */
  private async _refresh(): Promise<void> {
    // 合并自选股和持有股条目去重
    const watchlistEntries = this.stockManager.getAll();
    const portfolioEntries = this.stockManager.getPortfolio();
    const wishlistEntries = this.stockManager.getWishlist();
    const entries = [...new Map(
      [...watchlistEntries, ...portfolioEntries, ...wishlistEntries].map(e => [e.code.toLowerCase(), e])
    ).values()];
    const codes = entries.map(e => e.code);

    // 额外拉取内置指数代码和自定义关键词代码，用于注释装饰中的特殊关键词匹配
    const BUILTIN_INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000688'];
    const customCodes = Object.values(this.settings.customKeywords || {});

    // 收集注释中出现的股票代码（即使不在监控列表中）
    const commentCodes: string[] = [];
    for (const decorator of this.decorators) {
      if (typeof decorator.collectCommentCodes === 'function') {
        commentCodes.push(...decorator.collectCommentCodes());
      }
    }

    const allCodes = [...new Set([...codes, ...BUILTIN_INDEX_CODES, ...customCodes, ...commentCodes])];

    if (allCodes.length === 0) {
      return;
    }

    let stocks: StockData[];
    try {
      stocks = await this.dataProvider.fetchBatch(allCodes);
    } catch (err) {
      console.error('[PriceMonitor] fetchBatch 失败:', err);
      return;
    }

    if (stocks.length === 0) {
      console.warn('[PriceMonitor] fetchBatch 返回空数据，跳过本次分发');
      return;
    }

    await this._autoAddWishlistByTrend(watchlistEntries);

    // 分发给所有已注册的装饰器
    for (const decorator of this.decorators) {
      try {
        decorator.triggerUpdate(stocks, entries, this.settings);
      } catch (err) {
        console.error('[PriceMonitor] decorator.triggerUpdate 失败:', err);
      }
    }

  }

  private async _autoAddWishlistByTrend(watchlistEntries: StockEntry[]): Promise<void> {
    if (this.settings.autoWishlistEnabled === false) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAutoWishlistScanAt < AUTO_WISHLIST_SCAN_INTERVAL_MS) {
      return;
    }
    this.lastAutoWishlistScanAt = now;

    const wishlistCodes = new Set(this.stockManager.getWishlist().map(e => e.code.toLowerCase()));
    const candidates = watchlistEntries.filter(e => !wishlistCodes.has(e.code.toLowerCase()));
    if (candidates.length === 0) {
      return;
    }

    for (const entry of candidates) {
      try {
        const kline = await this.dataProvider.fetchKline(entry.code, AUTO_WISHLIST_KLINE_DAYS);
        const reason = this._getWishlistTrendReason(kline);
        if (!reason) {
          continue;
        }

        await this.stockManager.addWishlist({
          ...entry,
          addedAt: Date.now(),
        });
        wishlistCodes.add(entry.code.toLowerCase());
        console.log(`[PriceMonitor] 自动加入预购股：${entry.name}（${entry.code}），原因：${reason}`);
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (!message.includes('已存在')) {
          console.warn(`[PriceMonitor] 自动筛选预购股失败：${entry.code}`, err);
        }
      }
    }
  }

  private _getWishlistTrendReason(kline: KlineDay[]): string | null {
    const days = kline
      .filter(d => Number.isFinite(d.close) && d.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (days.length < 5) {
      return null;
    }

    let consecutiveDown = 0;
    for (let i = 1; i < days.length; i++) {
      if (days[i].close < days[i - 1].close) {
        consecutiveDown++;
        if (consecutiveDown >= AUTO_WISHLIST_CONSECUTIVE_DOWN_DAYS) {
          return `连续下跌 ${consecutiveDown} 天`;
        }
      } else {
        consecutiveDown = 0;
      }
    }

    const recent5 = days.slice(-5);
    const firstClose = recent5[0].close;
    const lastClose = recent5[recent5.length - 1].close;
    const dropRate = ((lastClose - firstClose) / firstClose) * 100;
    if (dropRate <= AUTO_WISHLIST_DROP_THRESHOLD) {
      return `近5日跌幅 ${dropRate.toFixed(2)}%`;
    }

    return null;
  }

  /**
   * 从 globalState 加载设置
   * 不存在时返回默认设置
   */
  private _loadSettings(): PluginSettings {
    try {
      const stored = this.context.globalState.get<PluginSettings>(STORAGE_KEYS.SETTINGS);
      if (stored && typeof stored === 'object') {
        // 深合并 decorationDisplay，确保新增字段有默认值
        const decorationDisplay = {
          ...DEFAULT_SETTINGS.decorationDisplay,
          ...(stored.decorationDisplay || {}),
        };
        // 清理 customKeywords 中的旧重复项，只保留去重后的默认原名和用户别名
        const defaultNames = Object.keys(DEFAULT_SETTINGS.customKeywords);
        const defaultCodes = Object.values(DEFAULT_SETTINGS.customKeywords);
        const oldKw: Record<string, string> = stored.customKeywords || {};
        const cleanKw: Record<string, string> = { ...DEFAULT_SETTINGS.customKeywords };
        // 旧数据中非默认原名的条目视为用户别名，保留
        for (const [k, v] of Object.entries(oldKw)) {
          if (!defaultNames.includes(k) && defaultCodes.includes(v)) {
            // 用户为某个默认代码设置的别名
            cleanKw[k] = v;
          } else if (!defaultNames.includes(k) && !defaultCodes.includes(v)) {
            // 完全自定义的条目，也保留
            cleanKw[k] = v;
          }
        }
        return { ...DEFAULT_SETTINGS, ...stored, decorationDisplay, customKeywords: cleanKw };
      }
    } catch (err) {
      console.error('[PriceMonitor] 从 globalState 加载设置失败，使用默认值:', err);
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * 将当前设置持久化到 globalState
   */
  private async _saveSettings(): Promise<void> {
    try {
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, this.settings);
    } catch (err) {
      console.error('[PriceMonitor] 持久化设置到 globalState 失败:', err);
      throw new Error(`设置持久化失败：${(err as Error).message}`);
    }
  }
}
