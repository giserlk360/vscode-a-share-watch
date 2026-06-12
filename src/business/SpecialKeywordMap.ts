/**
 * SpecialKeywordMap - 特殊关键词映射模块
 * 负责将特殊词汇（指数名称、用户别名、持仓关键词）映射到股票代码
 *
 * 需求参考：3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { StockEntry } from '../types';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 持仓关键词对应的特殊返回标记
 * CommentDecorator 识别此标记后，聚合计算所有持仓股票的总盈亏
 */
export const POSITION_KEYWORD = '持仓';
export const POSITION_SYMBOL = '__POSITION__';

/**
 * 内置特殊词汇到股票代码的映射表
 * 覆盖常见指数的中文简称
 */
const BUILTIN_KEYWORD_MAP: Record<string, string> = {
  '上证指数': 'sh000001',
  '深证成指': 'sz399001',
  '创业板指': 'sz399006',
  '沪深300': 'sh000300',
  '科创50': 'sh000688',
};

// ─── SpecialKeywordMap 主类 ───────────────────────────────────────────────────

export class SpecialKeywordMap {
  /**
   * 用户扩展别名映射表
   * key: 用户设置的 alias，value: 对应的股票代码
   */
  private userAliasMap: Map<string, string> = new Map();

  /**
   * 用户自定义特殊词汇映射表（来自设置面板）
   */
  private customKeywordMap: Map<string, string> = new Map();

  /**
   * 将关键词解析为股票代码
   *
   * 解析优先级：
   *   1. `持仓` 关键词 → 返回特殊标记 `__POSITION__`
   *   2. 内置映射表（指数名称）
   *   3. 用户扩展别名
   *
   * @param keyword 待解析的关键词
   * @returns 对应的股票代码，`持仓` 返回 `__POSITION__`，未匹配返回 null
   */
  resolve(keyword: string): string | null {
    if (!keyword) {
      return null;
    }

    // 1. 持仓关键词特殊处理
    if (keyword === POSITION_KEYWORD) {
      return POSITION_SYMBOL;
    }

    // 2. 内置映射表查找
    if (keyword in BUILTIN_KEYWORD_MAP) {
      return BUILTIN_KEYWORD_MAP[keyword];
    }

    // 3. 用户自定义特殊词汇查找
    const customCode = this.customKeywordMap.get(keyword);
    if (customCode !== undefined) {
      return customCode;
    }

    // 4. 用户扩展别名查找
    const userCode = this.userAliasMap.get(keyword);
    if (userCode !== undefined) {
      return userCode;
    }

    return null;
  }

  /**
   * 获取所有可识别的关键词列表
   * 包含内置关键词、`持仓` 以及用户扩展别名
   *
   * @returns 所有关键词数组（去重）
   */
  getAllKeywords(): string[] {
    const builtinKeys = Object.keys(BUILTIN_KEYWORD_MAP);
    const customKeys = Array.from(this.customKeywordMap.keys());
    const userAliasKeys = Array.from(this.userAliasMap.keys());

    return Array.from(new Set([POSITION_KEYWORD, ...builtinKeys, ...customKeys, ...userAliasKeys]));
  }

  /**
   * 从 StockManager 的股票条目列表中更新用户别名映射
   * 只处理设置了 `alias` 字段的条目
   *
   * @param entries StockManager 返回的股票条目列表
   */
  updateUserAliases(entries: StockEntry[]): void {
    this.userAliasMap.clear();
    for (const entry of entries) {
      if (entry.alias && entry.alias.trim()) {
        this.userAliasMap.set(entry.alias.trim(), entry.code);
      }
    }
  }

  /**
   * 更新用户自定义特殊词汇映射
   * @param keywords key: 别名, value: 股票代码（带前缀）
   */
  updateCustomKeywords(keywords: Record<string, string>): void {
    this.customKeywordMap.clear();
    for (const [alias, code] of Object.entries(keywords)) {
      if (alias && alias.trim() && code && code.trim()) {
        this.customKeywordMap.set(alias.trim(), code.trim());
      }
    }
  }

  /**
   * 获取所有自定义关键词对应的股票代码（用于额外拉取数据）
   */
  getCustomKeywordCodes(): string[] {
    return Array.from(this.customKeywordMap.values());
  }

  /**
   * 计算持仓总盈亏
   * 聚合所有设置了 `purchasePrice` 的股票，计算加权总盈亏
   *
   * 计算公式：
   *   每只股票盈亏比例 = (currentPrice - purchasePrice) / purchasePrice * 100
   *   总盈亏 = sum(每只股票盈亏比例) / 持仓股票数量（等权重平均）
   *
   * 注意：此方法需要外部传入实时价格数据，由 CommentDecorator 调用
   *
   * @param entries 所有股票条目
   * @param priceMap 股票代码到当前价格的映射
   * @returns 总盈亏百分比，无持仓时返回 null
   */
  calculatePositionProfit(
    entries: StockEntry[],
    priceMap: Map<string, number>
  ): number | null {
    // 筛选出设置了买入价格的持仓股票
    const positionEntries = entries.filter(
      e => e.purchasePrice !== undefined && e.purchasePrice > 0
    );

    if (positionEntries.length === 0) {
      return null;
    }

    let totalProfit = 0;
    let validCount = 0;

    for (const entry of positionEntries) {
      const currentPrice = priceMap.get(entry.code);
      // 如果没有当前价格数据，跳过该股票
      if (currentPrice === undefined || currentPrice <= 0) {
        continue;
      }

      const purchasePrice = entry.purchasePrice!;
      // 单只股票盈亏比例（百分比）
      const profit = (currentPrice - purchasePrice) / purchasePrice * 100;
      totalProfit += profit;
      validCount++;
    }

    if (validCount === 0) {
      return null;
    }

    // 等权重平均总盈亏
    return totalProfit / validCount;
  }
}
