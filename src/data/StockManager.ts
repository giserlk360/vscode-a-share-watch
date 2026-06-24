/**
 * StockManager - 股票信息管理模块
 * 负责股票的增删改查、持久化存储、导出导入功能
 */

import * as vscode from 'vscode';
import { StockEntry, ExportData, STORAGE_KEYS } from '../types';

// ─── 接口定义 ────────────────────────────────────────────────────────────────

/** 批量导入结果摘要 */
export interface ImportBatchResult {
  /** 成功添加数量 */
  added: number;
  /** 已存在跳过数量 */
  skipped: number;
  /** 失败数量（无效代码 + 解析失败） */
  failed: number;
  /** 每条失败项的描述 */
  errors: string[];
}

export interface IStockManager {
  // 自选股 CRUD
  add(entry: StockEntry): Promise<void>;
  remove(code: string): Promise<void>;
  update(code: string, patch: Partial<StockEntry>): Promise<void>;
  getAll(): StockEntry[];
  getByCode(code: string): StockEntry | undefined;
  findByKeyword(keyword: string): StockEntry | undefined;
  exportJSON(): string;
  importJSON(json: string): Promise<void>;
  addBatch(entries: StockEntry[]): Promise<ImportBatchResult>;
  // 持有股 CRUD
  addPortfolio(entry: StockEntry): Promise<void>;
  removePortfolio(code: string): Promise<void>;
  updatePortfolio(code: string, patch: Partial<StockEntry>): Promise<void>;
  getPortfolio(): StockEntry[];
  // 预购股 CRUD
  addWishlist(entry: StockEntry): Promise<void>;
  removeWishlist(code: string): Promise<void>;
  updateWishlist(code: string, patch: Partial<StockEntry>): Promise<void>;
  getWishlist(): StockEntry[];
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 导出格式版本号 */
const EXPORT_VERSION = '1.0';

/** 有效股票代码正则：带前缀（sh/sz）的6位数字，或纯6位数字 */
const CODE_WITH_PREFIX_REGEX = /^(sh|sz)\d{6}$/i;
const CODE_PURE_DIGITS_REGEX = /^\d{6}$/;

// ─── StockManager 主类 ────────────────────────────────────────────────────────

export class StockManager implements IStockManager {
  /** 内存中的自选股列表 */
  private stocks: StockEntry[] = [];
  /** 内存中的持有股列表 */
  private portfolio: StockEntry[] = [];
  /** 内存中的预购股列表 */
  private wishlist: StockEntry[] = [];

  /** VSCode 扩展上下文，用于访问 globalState */
  private context: vscode.ExtensionContext;

  /**
   * 构造函数
   * @param context VSCode 扩展上下文
   */
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    // 初始化时从 globalState 加载已有数据
    this._loadFromStorage();
    this._loadPortfolioFromStorage();
    this._loadWishlistFromStorage();
  }

  // ── 代码有效性验证 ────────────────────────────────────────────────────────────

  /**
   * 验证股票代码是否有效
   * 有效格式：
   *   - 带前缀的6位数字代码，如 "sh600036"、"sz000001"
   *   - 纯6位数字代码，如 "600036"、"000001"
   * @param code 待验证的股票代码
   * @returns 是否有效
   */
  static isValidCode(code: string): boolean {
    if (!code || typeof code !== 'string') {
      return false;
    }
    const trimmed = code.trim();
    return CODE_WITH_PREFIX_REGEX.test(trimmed) || CODE_PURE_DIGITS_REGEX.test(trimmed);
  }

  // ── 增删改查 ──────────────────────────────────────────────────────────────────

  /**
   * 添加股票到监控列表
   * 会验证代码有效性，拒绝无效代码
   * @param entry 股票条目
   * @throws 代码无效时抛出错误
   */
  async add(entry: StockEntry): Promise<void> {
    // 验证代码有效性
    if (!StockManager.isValidCode(entry.code)) {
      throw new Error(`无效的股票代码：${entry.code}。代码必须是带前缀（sh/sz）的6位数字，或纯6位数字。`);
    }

    // 检查是否已存在（按代码去重，忽略大小写）
    const normalizedCode = entry.code.toLowerCase();
    const exists = this.stocks.some(s => s.code.toLowerCase() === normalizedCode);
    if (exists) {
      throw new Error(`股票代码 ${entry.code} 已存在于监控列表中。`);
    }

    // 添加到内存列表
    this.stocks.push({ ...entry });

    // 持久化到 globalState
    await this._saveToStorage();
  }

  /**
   * 从监控列表中删除股票
   * @param code 股票代码（带前缀或纯数字均可）
   */
  async remove(code: string): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.stocks.findIndex(s => s.code.toLowerCase() === normalizedCode);

    if (index === -1) {
      // 代码不存在时静默忽略（幂等操作）
      return;
    }

    this.stocks.splice(index, 1);
    await this._saveToStorage();
  }

  /**
   * 更新股票信息
   * @param code 股票代码
   * @param patch 要更新的字段（部分更新）
   * @throws 代码不存在时抛出错误
   */
  async update(code: string, patch: Partial<StockEntry>): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.stocks.findIndex(s => s.code.toLowerCase() === normalizedCode);

    if (index === -1) {
      throw new Error(`股票代码 ${code} 不存在于监控列表中。`);
    }

    // 不允许通过 patch 修改 code 字段
    const { code: _ignoredCode, ...safePatch } = patch;

    this.stocks[index] = { ...this.stocks[index], ...safePatch };
    await this._saveToStorage();
  }

  /**
   * 获取所有股票列表
   * @returns 股票条目数组（副本）
   */
  getAll(): StockEntry[] {
    return [...this.stocks];
  }

  /**
   * 按代码查找股票
   * @param code 股票代码（带前缀或纯数字均可）
   * @returns 找到的股票条目，未找到返回 undefined
   */
  getByCode(code: string): StockEntry | undefined {
    const normalizedCode = code.toLowerCase();
    return this.stocks.find(s => s.code.toLowerCase() === normalizedCode);
  }

  /**
   * 按名称或别名查找股票
   * 先匹配别名，再匹配官方名称（精确匹配，忽略大小写）
   * @param keyword 关键词（股票名称或别名）
   * @returns 找到的第一个匹配股票条目，未找到返回 undefined
   */
  findByKeyword(keyword: string): StockEntry | undefined {
    if (!keyword) {
      return undefined;
    }

    const lowerKeyword = keyword.toLowerCase();

    // 优先匹配别名
    const byAlias = this.stocks.find(
      s => s.alias && s.alias.toLowerCase() === lowerKeyword
    );
    if (byAlias) {
      return byAlias;
    }

    // 再匹配官方名称
    return this.stocks.find(s => s.name.toLowerCase() === lowerKeyword);
  }

  // ── 导出导入 ──────────────────────────────────────────────────────────────────

  /**
   * 将股票列表导出为 JSON 字符串
   * 包含 version、exportedAt、stocks 字段
   * @returns JSON 字符串
   */
  exportJSON(): string {
    const exportData: ExportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      stocks: [...this.stocks],
    };
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * 从 JSON 字符串导入股票列表
   * 验证格式，格式错误时抛出异常
   * 导入会覆盖现有股票列表
   * @param json JSON 字符串
   * @throws 格式错误时抛出错误
   */
  async importJSON(json: string): Promise<void> {
    let parsed: unknown;

    // 解析 JSON
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`导入失败：JSON 格式错误。${(e as Error).message}`);
    }

    // 验证顶层结构
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('导入失败：JSON 必须是一个对象。');
    }

    const data = parsed as Record<string, unknown>;

    // 验证 version 字段
    if (typeof data.version !== 'string') {
      throw new Error('导入失败：缺少 version 字段或格式不正确。');
    }

    // 验证 stocks 字段
    if (!Array.isArray(data.stocks)) {
      throw new Error('导入失败：缺少 stocks 字段或不是数组。');
    }

    // 验证每个股票条目
    const importedStocks: StockEntry[] = [];
    for (let i = 0; i < data.stocks.length; i++) {
      const item = data.stocks[i];
      const validationError = this._validateStockEntry(item, i);
      if (validationError) {
        throw new Error(`导入失败：第 ${i + 1} 条股票数据无效。${validationError}`);
      }
      importedStocks.push(item as StockEntry);
    }

    // 覆盖现有列表并持久化
    this.stocks = importedStocks;
    await this._saveToStorage();
  }

  /**
   * 批量添加股票，跳过已存在的代码（合并式导入，不替换现有列表）
   * @param entries 待添加的股票条目数组
   * @returns 导入结果摘要
   */
  async addBatch(entries: StockEntry[]): Promise<ImportBatchResult> {
    const result: ImportBatchResult = { added: 0, skipped: 0, failed: 0, errors: [] };

    for (const entry of entries) {
      // 验证代码有效性
      if (!StockManager.isValidCode(entry.code)) {
        result.failed++;
        result.errors.push(`无效代码: ${entry.code}`);
        continue;
      }

      // 去重检查（忽略大小写）
      const normalizedCode = entry.code.toLowerCase();
      const exists = this.stocks.some(s => s.code.toLowerCase() === normalizedCode);
      if (exists) {
        result.skipped++;
        continue;
      }

      // 添加到内存列表（默认值 + entry 可选字段，code/名称/内部字段始终用标准值）
      const { code: _c, name: _n, alertEnabled: _a, carouselEnabled: _ca, addedAt: _at, ...safeEntry } = entry;
      this.stocks.push({
        code: normalizedCode,
        name: entry.name || entry.code,
        alertEnabled: false,
        carouselEnabled: true,
        addedAt: Date.now(),
        ...safeEntry,
      });
      result.added++;
    }

    // 有新增时统一持久化
    if (result.added > 0) {
      await this._saveToStorage();
    }

    return result;
  }

  // ── 持有股 CRUD ──────────────────────────────────────────────────────────────

  /**
   * 添加股票到持有股列表
   * 与自选股独立存储，不检查自选股重复
   */
  async addPortfolio(entry: StockEntry): Promise<void> {
    if (!StockManager.isValidCode(entry.code)) {
      throw new Error(`无效的股票代码：${entry.code}。代码必须是带前缀（sh/sz）的6位数字，或纯6位数字。`);
    }
    const normalizedCode = entry.code.toLowerCase();
    const exists = this.portfolio.some(s => s.code.toLowerCase() === normalizedCode);
    if (exists) {
      throw new Error(`股票代码 ${entry.code} 已存在于持有股列表中。`);
    }
    this.portfolio.push({ ...entry, code: normalizedCode });
    await this._savePortfolioToStorage();
  }

  /**
   * 从持有股列表中删除股票
   */
  async removePortfolio(code: string): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.portfolio.findIndex(s => s.code.toLowerCase() === normalizedCode);
    if (index === -1) { return; }
    this.portfolio.splice(index, 1);
    await this._savePortfolioToStorage();
  }

  /**
   * 更新持有股信息
   */
  async updatePortfolio(code: string, patch: Partial<StockEntry>): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.portfolio.findIndex(s => s.code.toLowerCase() === normalizedCode);
    if (index === -1) {
      throw new Error(`股票代码 ${code} 不存在于持有股列表中。`);
    }
    const { code: _ignoredCode, ...safePatch } = patch;
    this.portfolio[index] = { ...this.portfolio[index], ...safePatch };
    await this._savePortfolioToStorage();
  }

  /**
   * 获取所有持有股列表
   */
  getPortfolio(): StockEntry[] {
    return [...this.portfolio];
  }

  // ── 预购股 CRUD ──────────────────────────────────────────────────────────────

  async addWishlist(entry: StockEntry): Promise<void> {
    if (!StockManager.isValidCode(entry.code)) {
      throw new Error(`无效的股票代码：${entry.code}。代码必须是带前缀（sh/sz）的6位数字，或纯6位数字。`);
    }
    const normalizedCode = entry.code.toLowerCase();
    const exists = this.wishlist.some(s => s.code.toLowerCase() === normalizedCode);
    if (exists) {
      throw new Error(`股票代码 ${entry.code} 已存在于预购股列表中。`);
    }
    this.wishlist.push({ ...entry, code: normalizedCode });
    await this._saveWishlistToStorage();
  }

  async removeWishlist(code: string): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.wishlist.findIndex(s => s.code.toLowerCase() === normalizedCode);
    if (index === -1) { return; }
    this.wishlist.splice(index, 1);
    await this._saveWishlistToStorage();
  }

  async updateWishlist(code: string, patch: Partial<StockEntry>): Promise<void> {
    const normalizedCode = code.toLowerCase();
    const index = this.wishlist.findIndex(s => s.code.toLowerCase() === normalizedCode);
    if (index === -1) {
      throw new Error(`股票代码 ${code} 不存在于预购股列表中。`);
    }
    const { code: _ignoredCode, ...safePatch } = patch;
    this.wishlist[index] = { ...this.wishlist[index], ...safePatch };
    await this._saveWishlistToStorage();
  }

  getWishlist(): StockEntry[] {
    return [...this.wishlist];
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────────────

  /**
   * 从 globalState 加载股票数据
   * 加载失败时使用空列表初始化
   */
  private _loadFromStorage(): void {
    try {
      const stored = this.context.globalState.get<StockEntry[]>(STORAGE_KEYS.STOCKS);
      if (Array.isArray(stored)) {
        this.stocks = stored;
      } else {
        this.stocks = [];
      }
    } catch (e) {
      console.error('[StockManager] 从 globalState 加载数据失败，使用空列表初始化:', e);
      this.stocks = [];
    }
  }

  /**
   * 将股票数据持久化到 globalState
   */
  private async _saveToStorage(): Promise<void> {
    try {
      await this.context.globalState.update(STORAGE_KEYS.STOCKS, this.stocks);
    } catch (e) {
      console.error('[StockManager] 持久化到 globalState 失败:', e);
      throw new Error(`持久化失败：${(e as Error).message}`);
    }
  }

  /**
   * 从 globalState 加载持有股数据
   */
  private _loadPortfolioFromStorage(): void {
    try {
      const stored = this.context.globalState.get<StockEntry[]>(STORAGE_KEYS.PORTFOLIO);
      if (Array.isArray(stored)) {
        this.portfolio = stored;
      } else {
        this.portfolio = [];
      }
    } catch (e) {
      console.error('[StockManager] 加载持有股数据失败，使用空列表初始化:', e);
      this.portfolio = [];
    }
  }

  /**
   * 将持有股数据持久化到 globalState
   */
  private async _savePortfolioToStorage(): Promise<void> {
    try {
      await this.context.globalState.update(STORAGE_KEYS.PORTFOLIO, this.portfolio);
    } catch (e) {
      console.error('[StockManager] 持久化持有股到 globalState 失败:', e);
      throw new Error(`持久化失败：${(e as Error).message}`);
    }
  }

  /**
   * 从 globalState 加载预购股数据
   */
  private _loadWishlistFromStorage(): void {
    try {
      const stored = this.context.globalState.get<StockEntry[]>(STORAGE_KEYS.WISHLIST);
      if (Array.isArray(stored)) {
        this.wishlist = stored;
      } else {
        this.wishlist = [];
      }
    } catch (e) {
      console.error('[StockManager] 加载预购股数据失败，使用空列表初始化:', e);
      this.wishlist = [];
    }
  }

  /**
   * 将预购股数据持久化到 globalState
   */
  private async _saveWishlistToStorage(): Promise<void> {
    try {
      await this.context.globalState.update(STORAGE_KEYS.WISHLIST, this.wishlist);
    } catch (e) {
      console.error('[StockManager] 持久化预购股到 globalState 失败:', e);
      throw new Error(`持久化失败：${(e as Error).message}`);
    }
  }

  /**
   * 验证单个股票条目的格式
   * @param item 待验证的对象
   * @param index 在数组中的索引（用于错误提示）
   * @returns 错误信息字符串，验证通过时返回 null
   */
  private _validateStockEntry(item: unknown, index: number): string | null {
    if (!item || typeof item !== 'object') {
      return '条目必须是一个对象。';
    }

    const entry = item as Record<string, unknown>;

    // 验证必填字段 code
    if (typeof entry.code !== 'string' || !entry.code) {
      return '缺少 code 字段或不是字符串。';
    }
    if (!StockManager.isValidCode(entry.code)) {
      return `code "${entry.code}" 不是有效的股票代码。`;
    }

    // 验证必填字段 name
    if (typeof entry.name !== 'string' || !entry.name) {
      return '缺少 name 字段或不是字符串。';
    }

    // 验证必填字段 alertEnabled
    if (typeof entry.alertEnabled !== 'boolean') {
      return '缺少 alertEnabled 字段或不是布尔值。';
    }

    // 验证必填字段 carouselEnabled
    if (typeof entry.carouselEnabled !== 'boolean') {
      return '缺少 carouselEnabled 字段或不是布尔值。';
    }

    // 验证必填字段 addedAt
    if (typeof entry.addedAt !== 'number') {
      return '缺少 addedAt 字段或不是数字。';
    }

    // 验证可选字段类型
    if (entry.alias !== undefined && typeof entry.alias !== 'string') {
      return 'alias 字段必须是字符串。';
    }
    if (entry.purchasePrice !== undefined && typeof entry.purchasePrice !== 'number') {
      return 'purchasePrice 字段必须是数字。';
    }
    if (entry.targetPrice !== undefined && typeof entry.targetPrice !== 'number') {
      return 'targetPrice 字段必须是数字。';
    }
    if (entry.targetChangeRate !== undefined && typeof entry.targetChangeRate !== 'number') {
      return 'targetChangeRate 字段必须是数字。';
    }

    return null;
  }
}
