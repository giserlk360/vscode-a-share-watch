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

/** 筛选用K线天数（需覆盖20日窗口及20日均线） */
const AUTO_WISHLIST_KLINE_DAYS = 30;

/** 回调评分制：各维度按强度计 1~2 分，总分达到门槛才入选，避免单一温和信号误入选 */
const PULLBACK_MIN_SCORE = 3;

/** 单次筛选最多加入预购股的数量（达标较多时按评分从高到低截取，保证结果有界且是回调最深的） */
const PULLBACK_TOP_N = 10;

/** 各维度两档阈值：达到弱档计1分，达到强档计2分 */
/** 近20日高点回撤（%） */
const PULLBACK_DRAWDOWN_MID = -10;
const PULLBACK_DRAWDOWN_STRONG = -15;
/** 近5日区间跌幅（%，急跌） */
const PULLBACK_DROP5_MID = -8;
const PULLBACK_DROP5_STRONG = -12;
/** 近10日区间跌幅（%） */
const PULLBACK_DROP10_MID = -12;
/** 近20日区间跌幅（%） */
const PULLBACK_DROP20_MID = -18;
/** 尾部连续下跌天数 */
const PULLBACK_STREAK_MID = 4;
const PULLBACK_STREAK_STRONG = 5;
/** 近10日下跌天数（阴跌，仅一档） */
const PULLBACK_DOWN_DAYS_10 = 6;
/** 收盘价相对20日均线乖离率（%，超卖） */
const PULLBACK_BIAS_MID = -8;
const PULLBACK_BIAS_STRONG = -12;

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
  /** 手动触发：从自选股中筛选回调股加入预购股（评分制，按分数截取前若干只） */
  filterWishlistNow(): Promise<{ added: string[]; droppedByCap: number }>;
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

    // 分发给所有已注册的装饰器
    for (const decorator of this.decorators) {
      try {
        decorator.triggerUpdate(stocks, entries, this.settings);
      } catch (err) {
        console.error('[PriceMonitor] decorator.triggerUpdate 失败:', err);
      }
    }

  }

  /**
   * 手动触发：从自选股中筛选回调股加入预购股
   * 评分制：总分 ≥ PULLBACK_MIN_SCORE 达标；达标较多时按评分从高到低最多取 PULLBACK_TOP_N 只
   * @returns 新增的股票描述列表（名称+评分+原因）及达标但未进前列的数量
   */
  async filterWishlistNow(): Promise<{ added: string[]; droppedByCap: number }> {
    const watchlistEntries = this.stockManager.getAll();
    const wishlistCodes = new Set(this.stockManager.getWishlist().map(e => e.code.toLowerCase()));
    const candidates = watchlistEntries.filter(e => !wishlistCodes.has(e.code.toLowerCase()));
    const qualified: Array<{ entry: StockEntry; score: number; reason: string }> = [];

    for (const entry of candidates) {
      try {
        const kline = await this.dataProvider.fetchKline(entry.code, AUTO_WISHLIST_KLINE_DAYS);
        const r = this._getWishlistTrendReason(kline);
        if (r) {
          qualified.push({ entry, ...r });
        }
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (!message.includes('已存在')) {
          console.warn(`[PriceMonitor] 筛选预购股失败：${entry.code}`, err);
        }
      }
      // 请求间加短暂延迟，避免接口限流
      await new Promise(r => setTimeout(r, 200));
    }

    // 评分从高到低，最多取前 N 只，保证结果有界且是回调最深的
    qualified.sort((a, b) => b.score - a.score);
    const picked = qualified.slice(0, PULLBACK_TOP_N);
    const added: string[] = [];

    for (const { entry, score, reason } of picked) {
      try {
        await this.stockManager.addWishlist({
          ...entry,
          addedAt: Date.now(),
        });
        wishlistCodes.add(entry.code.toLowerCase());
        added.push(`${entry.name}（评分${score}：${reason}）`);
        console.log(`[PriceMonitor] 筛选加入预购股：${entry.name}（${entry.code}），评分${score}，原因：${reason}`);
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (!message.includes('已存在')) {
          console.warn(`[PriceMonitor] 加入预购股失败：${entry.code}`, err);
        }
      }
    }

    return { added, droppedByCap: qualified.length - picked.length };
  }

  /**
   * 判断是否符合回调股条件（评分制，总分 ≥ PULLBACK_MIN_SCORE 才入选）
   * 四个维度按强度计 1~2 分，命中的理由合并展示：
   *   1. 近20日高点回撤 —— 比"固定起点点对点跌幅"更能刻画"涨完回落"，与回落起点无关
   *   2. 多窗口区间跌幅 —— 5/10/20日梯度阈值，兼顾急跌与慢回调
   *   3. 下跌结构 —— 尾部连续下跌（当前正在回调）或近10日阴跌天数
   *   4. 超卖乖离 —— 收盘价显著低于20日均线，识别跌过头
   * 单个强信号（2分）不单独入选，需更强或多维度相互印证
   * @returns 命中时返回 { score, reason }，未达门槛返回 null
   */
  private _getWishlistTrendReason(kline: KlineDay[]): { score: number; reason: string } | null {
    const days = kline
      .filter(d => Number.isFinite(d.close) && d.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (days.length < 10) {
      return null;
    }
    const closes = days.map(d => d.close);
    const last = closes[closes.length - 1];
    let score = 0;
    const reasons: string[] = [];

    // 1) 近20日高点回撤
    const win20 = closes.slice(-20);
    const high20 = Math.max(...win20);
    if (high20 > 0) {
      const drawdown = (last - high20) / high20 * 100;
      if (drawdown <= PULLBACK_DRAWDOWN_STRONG) {
        score += 2;
        reasons.push(`20日高点回撤${drawdown.toFixed(1)}%`);
      } else if (drawdown <= PULLBACK_DRAWDOWN_MID) {
        score += 1;
        reasons.push(`20日高点回撤${drawdown.toFixed(1)}%`);
      }
    }

    // 2) 多窗口区间跌幅（急跌优先报告更短窗口）
    const rangeDrop = (n: number): number | null => {
      if (closes.length < n + 1) { return null; }
      const start = closes[closes.length - 1 - n];
      return start > 0 ? (last - start) / start * 100 : null;
    };
    const drop5 = rangeDrop(5);
    const drop10 = rangeDrop(10);
    const drop20 = rangeDrop(20);
    if (drop5 !== null && drop5 <= PULLBACK_DROP5_STRONG) {
      score += 2;
      reasons.push(`近5日${drop5.toFixed(1)}%`);
    } else if (drop5 !== null && drop5 <= PULLBACK_DROP5_MID) {
      score += 1;
      reasons.push(`近5日${drop5.toFixed(1)}%`);
    } else if (drop10 !== null && drop10 <= PULLBACK_DROP10_MID) {
      score += 1;
      reasons.push(`近10日${drop10.toFixed(1)}%`);
    } else if (drop20 !== null && drop20 <= PULLBACK_DROP20_MID) {
      score += 1;
      reasons.push(`近20日${drop20.toFixed(1)}%`);
    }

    // 3) 下跌结构：尾部连续下跌（从最新一根往回数）或近10日阴跌天数
    let streak = 0;
    for (let i = closes.length - 1; i > 0 && closes[i] < closes[i - 1]; i--) {
      streak++;
    }
    if (streak >= PULLBACK_STREAK_STRONG) {
      score += 2;
      reasons.push(`连续下跌${streak}天`);
    } else if (streak >= PULLBACK_STREAK_MID) {
      score += 1;
      reasons.push(`连续下跌${streak}天`);
    } else {
      const win11 = closes.slice(-11);
      let downDays = 0;
      for (let i = 1; i < win11.length; i++) {
        if (win11[i] < win11[i - 1]) { downDays++; }
      }
      if (downDays >= PULLBACK_DOWN_DAYS_10) {
        score += 1;
        reasons.push(`近10日${downDays}天下跌`);
      }
    }

    // 4) 超卖乖离：收盘价显著低于20日均线
    if (closes.length >= 20) {
      const ma20 = win20.reduce((a, v) => a + v, 0) / win20.length;
      const bias = (last - ma20) / ma20 * 100;
      if (bias <= PULLBACK_BIAS_STRONG) {
        score += 2;
        reasons.push(`低于20日线${Math.abs(bias).toFixed(1)}%`);
      } else if (bias <= PULLBACK_BIAS_MID) {
        score += 1;
        reasons.push(`低于20日线${Math.abs(bias).toFixed(1)}%`);
      }
    }

    if (score < PULLBACK_MIN_SCORE) {
      return null;
    }
    return { score, reason: reasons.join('、') };
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
