/**
 * CommentDecorator - 注释装饰器
 * 扫描代码注释中的股票代码/名称/别名/特殊词汇，以内联方式显示涨跌幅
 *
 * 需求参考：2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.5, 3.6
 */

import * as vscode from 'vscode';
import { StockData, StockEntry, CommentMatch, DecorationDisplayOptions, PluginSettings } from '../types';
import { SpecialKeywordMap, POSITION_SYMBOL } from '../business/SpecialKeywordMap';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 多语言注释扫描正则
 * 按顺序匹配各语言的注释语法
 */
const COMMENT_PATTERNS: RegExp[] = [
  /\/\/.*$/gm,           // JS/TS/Java 单行注释
  /\/\*[\s\S]*?\*\//gm,  // 块注释
  /#.*$/gm,              // Python/Shell/Ruby
  /--.*$/gm,             // SQL/Lua
  /<!--[\s\S]*?-->/gm,   // HTML
];

/** 6位纯数字股票代码正则：前后必须是空白、行首/行尾或非字母数字字符 */
const CODE_REGEX = /(?<![a-zA-Z0-9])(\d{6})(?![a-zA-Z0-9])/g;

/** 上涨颜色（红色） */
const COLOR_UP = '#F14C4C';

/** 下跌颜色（绿色） */
const COLOR_DOWN = '#73C991';

// ─── 接口定义 ────────────────────────────────────────────────────────────────

export interface ICommentDecorator {
  activate(context: vscode.ExtensionContext): void;
  triggerUpdate(stocks: StockData[]): void;
  updateDecorations(editor: vscode.TextEditor): void;
  setStealthMode(enabled: boolean): void;
  dispose(): void;
}

// ─── CommentDecorator 主类 ────────────────────────────────────────────────────

export class CommentDecorator implements ICommentDecorator {
  /** 当前最新的股票数据列表 */
  private stockDataList: StockData[] = [];

  /** 股票条目列表（含别名、买入价等信息） */
  private stockEntries: StockEntry[] = [];

  /** 特殊词汇映射器 */
  private specialKeywordMap: SpecialKeywordMap;

  /** 是否处于隐蔽模式 */
  private stealthMode: boolean = false;

  /** 注释装饰显示选项 */
  private decorationDisplay: DecorationDisplayOptions = {
    showPrice: true,
    showChangeRate: true,
    showChangeAmount: false,
    showPositionProfit: false,
    showDailyProfit: false,
  };

  /**
   * 当前所有活跃的装饰类型
   * 每次刷新前先 dispose 旧的，再创建新的
   */
  private decorationTypes: vscode.TextEditorDecorationType[] = [];

  /** 事件监听器的 Disposable 列表，用于 dispose 时清理 */
  private disposables: vscode.Disposable[] = [];

  /**
   * 构造函数
   * @param stockEntries 初始股票条目列表（含别名信息）
   */
  constructor(stockEntries: StockEntry[] = []) {
    this.specialKeywordMap = new SpecialKeywordMap();
    this.stockEntries = stockEntries;
    // 初始化用户别名映射
    this.specialKeywordMap.updateUserAliases(stockEntries);
  }

  // ── 公开方法 ──────────────────────────────────────────────────────────────────

  /**
   * 激活装饰器，注册编辑器事件监听
   * @param context VSCode 扩展上下文
   */
  activate(context: vscode.ExtensionContext): void {
    // 监听活跃编辑器切换事件
    const onEditorChange = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        this.updateDecorations(editor);
      }
    });

    // 监听文档内容变化事件
    const onDocChange = vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        this.updateDecorations(editor);
      }
    });

    this.disposables.push(onEditorChange, onDocChange);
    context.subscriptions.push(onEditorChange, onDocChange);

    // 立即对当前活跃编辑器执行一次装饰
    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  /**
   * 更新股票数据并刷新所有编辑器装饰
   * 由 PriceMonitor 定时调用
   * @param stocks 最新的股票数据列表
   * @param entries 最新的股票条目列表（可选，用于更新别名映射）
   */
  triggerUpdate(stocks: StockData[], entries?: StockEntry[], settings?: PluginSettings): void {
    this.stockDataList = stocks;

    // 同步更新股票条目（别名等信息）
    if (entries) {
      this.stockEntries = entries;
      this.specialKeywordMap.updateUserAliases(entries);
    }

    // 从设置中同步隐蔽模式和装饰显示选项
    if (settings) {
      this.stealthMode = !!settings.stealthMode;
      if (settings.decorationDisplay) {
        this.decorationDisplay = { ...settings.decorationDisplay };
      }
      if (settings.customKeywords) {
        this.specialKeywordMap.updateCustomKeywords(settings.customKeywords);
      }
    }

    // 刷新当前活跃编辑器的装饰
    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  /**
   * 更新指定编辑器的注释装饰
   * 扫描注释 → 匹配股票 → 创建装饰类型 → 应用到编辑器
   * @param editor 目标编辑器
   */
  updateDecorations(editor: vscode.TextEditor): void {
    // 清除旧的装饰类型
    this._clearDecorations(editor);

    if (this.stockDataList.length === 0) {
      return;
    }

    const text = editor.document.getText();
    const matches = this.scanComments(text, this.stockDataList);

    if (matches.length === 0) {
      return;
    }

    // 按股票代码分组，每个代码创建一个装饰类型
    const matchesByCode = new Map<string, CommentMatch[]>();
    for (const match of matches) {
      const list = matchesByCode.get(match.code) ?? [];
      list.push(match);
      matchesByCode.set(match.code, list);
    }

    // 为每个匹配到的股票代码创建装饰
    for (const [code, codeMatches] of matchesByCode) {
      // 处理持仓聚合
      if (code === POSITION_SYMBOL) {
        this._applyPositionDecoration(editor, codeMatches);
        continue;
      }

      // 查找对应的股票数据
      const stockData = this.stockDataList.find(s => s.code === code);
      if (!stockData) {
        continue;
      }

      this._applyStockDecoration(editor, codeMatches, stockData);
    }
  }

  /**
   * 设置隐蔽模式
   * 隐蔽模式下装饰颜色与注释颜色一致，不显眼
   * @param enabled 是否启用隐蔽模式
   */
  setStealthMode(enabled: boolean): void {
    this.stealthMode = enabled;

    // 立即刷新当前编辑器装饰以应用新模式
    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  /**
   * 更新注释装饰显示选项
   * @param options 显示选项
   */
  updateDecorationDisplay(options: DecorationDisplayOptions): void {
    this.decorationDisplay = { ...options };

    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  /**
   * 更新股票条目列表（含别名信息）
   * 当用户修改别名时由外部调用
   * @param entries 最新的股票条目列表
   */
  updateStockEntries(entries: StockEntry[]): void {
    this.stockEntries = entries;
    this.specialKeywordMap.updateUserAliases(entries);
  }

  /**
   * 扫描文本中的注释，返回所有匹配到的股票位置
   * 此方法为公开方法，供属性测试调用
   *
   * 匹配优先级：
   *   1. 特殊词汇（上证指数、深成、创业板、持仓）
   *   2. 用户别名
   *   3. 股票名称（官方名称）
   *   4. 6位股票代码
   *
   * @param text 文档全文
   * @param stocks 当前股票数据列表
   * @returns 所有匹配结果数组
   */
  scanComments(text: string, stocks: StockData[]): CommentMatch[] {
    const results: CommentMatch[] = [];

    // 提取所有注释区间（[startIndex, endIndex]）
    const commentRanges = this._extractCommentRanges(text);

    if (commentRanges.length === 0) {
      return results;
    }

    // 构建各优先级的匹配词汇表
    const specialKeywords = this.specialKeywordMap.getAllKeywords();
    const aliasMap = this._buildAliasMap();
    const nameMap = this._buildNameMap(stocks);
    const codeSet = new Set(stocks.map(s => s.code));

    // 用于去重：同一位置只记录一次（最高优先级）
    // key: `${line}:${startChar}`
    const usedPositions = new Set<string>();

    // 遍历每个注释区间，在其中搜索匹配
    for (const [commentStart, commentEnd] of commentRanges) {
      const commentText = text.slice(commentStart, commentEnd);

      // 优先级 1：特殊词汇
      this._matchKeywords(
        commentText, commentStart, text, specialKeywords,
        (keyword) => {
          const code = this.specialKeywordMap.resolve(keyword);
          return code;
        },
        'special', results, usedPositions
      );

      // 优先级 2：用户别名
      this._matchKeywords(
        commentText, commentStart, text, Array.from(aliasMap.keys()),
        (alias) => aliasMap.get(alias) ?? null,
        'alias', results, usedPositions
      );

      // 优先级 3：股票官方名称
      this._matchKeywords(
        commentText, commentStart, text, Array.from(nameMap.keys()),
        (name) => nameMap.get(name) ?? null,
        'name', results, usedPositions
      );

      // 优先级 4：6位股票代码
      this._matchCodes(
        commentText, commentStart, text, codeSet,
        results, usedPositions
      );
    }

    return results;
  }

  /**
   * 释放所有资源
   * 清除装饰类型和事件监听器
   */
  /**
   * 收集当前所有打开编辑器中注释里出现的股票代码
   * 用于 PriceMonitor 额外拉取未在监控列表中的股票数据
   */
  collectCommentCodes(): string[] {
    const codes = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      const text = editor.document.getText();
      const commentRanges = this._extractCommentRanges(text);
      for (const [commentStart, commentEnd] of commentRanges) {
        const commentText = text.slice(commentStart, commentEnd);
        const regex = new RegExp(CODE_REGEX.source, CODE_REGEX.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(commentText)) !== null) {
          const pureCode = match[1];
          const fullCode = this._findCodeByPureDigits(pureCode, new Set());
          if (fullCode) {
            codes.add(fullCode);
          }
        }
      }
    }
    return Array.from(codes);
  }

  dispose(): void {
    // 清除所有装饰类型
    for (const dt of this.decorationTypes) {
      dt.dispose();
    }
    this.decorationTypes = [];

    // 清除所有事件监听器
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────────────

  /**
   * 提取文本中所有注释的字符偏移区间
   * 返回 [startIndex, endIndex] 数组
   * @param text 文档全文
   */
  private _extractCommentRanges(text: string): [number, number][] {
    const ranges: [number, number][] = [];

    for (const pattern of COMMENT_PATTERNS) {
      // 重置正则状态（lastIndex）
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        ranges.push([match.index, match.index + match[0].length]);
      }
    }

    // 按起始位置排序，便于后续处理
    ranges.sort((a, b) => a[0] - b[0]);

    return ranges;
  }

  /**
   * 在注释文本中匹配关键词列表
   * @param commentText 注释文本片段
   * @param commentStart 注释在文档中的起始偏移
   * @param fullText 文档全文（用于计算行列号）
   * @param keywords 待匹配的关键词列表
   * @param resolveCode 关键词 → 股票代码的解析函数
   * @param matchType 匹配类型
   * @param results 结果数组（追加）
   * @param usedPositions 已使用位置集合（去重）
   */
  private _matchKeywords(
    commentText: string,
    commentStart: number,
    fullText: string,
    keywords: string[],
    resolveCode: (keyword: string) => string | null,
    matchType: CommentMatch['matchType'],
    results: CommentMatch[],
    usedPositions: Set<string>
  ): void {
    for (const keyword of keywords) {
      if (!keyword || keyword.length === 0) {
        continue;
      }

      // 在注释文本中查找所有出现位置
      let searchStart = 0;
      while (true) {
        const idx = commentText.indexOf(keyword, searchStart);
        if (idx === -1) {
          break;
        }

        // 计算在文档中的绝对偏移
        const absOffset = commentStart + idx;
        const { line, startChar } = this._offsetToLineChar(fullText, absOffset);
        const endChar = startChar + keyword.length;
        const posKey = `${line}:${startChar}`;

        if (!usedPositions.has(posKey)) {
          const code = resolveCode(keyword);
          if (code !== null) {
            usedPositions.add(posKey);
            results.push({
              code,
              range: { line, startChar, endChar },
              matchType,
            });
          }
        }

        searchStart = idx + keyword.length;
      }
    }
  }

  /**
   * 在注释文本中匹配6位股票代码
   * @param commentText 注释文本片段
   * @param commentStart 注释在文档中的起始偏移
   * @param fullText 文档全文
   * @param codeSet 有效股票代码集合（带前缀，如 "sh600036"）
   * @param results 结果数组（追加）
   * @param usedPositions 已使用位置集合（去重）
   */
  private _matchCodes(
    commentText: string,
    commentStart: number,
    fullText: string,
    codeSet: Set<string>,
    results: CommentMatch[],
    usedPositions: Set<string>
  ): void {
    const regex = new RegExp(CODE_REGEX.source, CODE_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(commentText)) !== null) {
      const pureCode = match[1]; // 6位纯数字

      // 查找对应的带前缀代码
      const fullCode = this._findCodeByPureDigits(pureCode, codeSet);
      if (!fullCode) {
        continue;
      }

      const absOffset = commentStart + match.index;
      const { line, startChar } = this._offsetToLineChar(fullText, absOffset);
      const endChar = startChar + pureCode.length;
      const posKey = `${line}:${startChar}`;

      if (!usedPositions.has(posKey)) {
        usedPositions.add(posKey);
        results.push({
          code: fullCode,
          range: { line, startChar, endChar },
          matchType: 'code',
        });
      }
    }
  }

  /**
   * 根据6位纯数字代码在代码集合中查找带前缀的完整代码
   * @param pureCode 6位纯数字代码
   * @param codeSet 带前缀的代码集合
   * @returns 带前缀的完整代码，未找到返回 null
   */
  private _findCodeByPureDigits(pureCode: string, codeSet: Set<string>): string | null {
    // 尝试 sh 前缀
    if (codeSet.has(`sh${pureCode}`)) {
      return `sh${pureCode}`;
    }
    // 尝试 sz 前缀
    if (codeSet.has(`sz${pureCode}`)) {
      return `sz${pureCode}`;
    }
    // 不在已有数据集中时，根据代码规则推断前缀
    // 6/9 开头 → 上海(sh)，0/1/2/3 开头 → 深圳(sz)
    const first = pureCode[0];
    if (first === '6' || first === '9') {
      return `sh${pureCode}`;
    }
    if (first === '0' || first === '1' || first === '2' || first === '3') {
      return `sz${pureCode}`;
    }
    return null;
  }

  /**
   * 将文档字符偏移转换为行号和列号
   * @param text 文档全文
   * @param offset 字符偏移（从0开始）
   * @returns { line: 行号（从0开始）, startChar: 列号（从0开始）}
   */
  private _offsetToLineChar(text: string, offset: number): { line: number; startChar: number } {
    let line = 0;
    let lastNewline = -1;

    for (let i = 0; i < offset; i++) {
      if (text[i] === '\n') {
        line++;
        lastNewline = i;
      }
    }

    const startChar = offset - lastNewline - 1;
    return { line, startChar };
  }

  /**
   * 构建别名 → 股票代码的映射表
   * 从 stockEntries 中提取设置了 alias 的条目
   */
  private _buildAliasMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of this.stockEntries) {
      if (entry.alias && entry.alias.trim()) {
        map.set(entry.alias.trim(), entry.code);
      }
    }
    return map;
  }

  /**
   * 构建股票名称 → 股票代码的映射表
   * 从 stocks 数据中提取
   * @param stocks 股票数据列表
   */
  private _buildNameMap(stocks: StockData[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const stock of stocks) {
      if (stock.name && stock.name.trim()) {
        map.set(stock.name.trim(), stock.code);
      }
    }
    return map;
  }

  /**
   * 根据用户配置构建装饰文本
   * @param stockData 股票实时数据
   */
  private _buildDecorationText(stockData: StockData): string {
    const parts: string[] = [];
    const d = this.decorationDisplay;
    const isETF = stockData.isETF;
    const decimals = isETF ? 3 : 2;

    // 当前价格
    if (d.showPrice) {
      parts.push(`${stockData.currentPrice.toFixed(decimals)}`);
    }

    // 涨跌幅
    if (d.showChangeRate) {
      const sign = stockData.changeRate >= 0 ? '+' : '';
      parts.push(`${sign}${stockData.changeRate.toFixed(decimals)}%`);
    }

    // 涨跌额
    if (d.showChangeAmount) {
      const sign = stockData.changeAmount >= 0 ? '+' : '';
      parts.push(`${sign}${stockData.changeAmount.toFixed(decimals)}`);
    }

    // 持仓盈亏（需要找到对应的 entry）
    if (d.showPositionProfit) {
      const entry = this.stockEntries.find(e => e.code === stockData.code);
      if (entry?.purchasePrice && entry.purchasePrice > 0 && entry.shares && entry.shares > 0) {
        const profit = (stockData.currentPrice - entry.purchasePrice) * entry.shares;
        const sign = profit >= 0 ? '+' : '-';
        parts.push(`${sign}${Math.abs(profit).toFixed(2)}`);
      }
    }

    // 当日盈亏：(当前价 - 昨收价) × 股数
    if (d.showDailyProfit) {
      const entry = this.stockEntries.find(e => e.code === stockData.code);
      if (entry?.shares && entry.shares > 0 && stockData.closePrice > 0) {
        const dailyProfit = (stockData.currentPrice - stockData.closePrice) * entry.shares;
        const sign = dailyProfit >= 0 ? '+' : '-';
        parts.push(`今${sign}${Math.abs(dailyProfit).toFixed(2)}`);
      }
    }

    if (parts.length === 0) {
      return '';
    }
    return ` ${parts.join(' ')}`;
  }

  /**
   * 格式化涨跌幅显示文本
   * ETF 显示三位小数，个股显示两位小数
   * 格式：` +4.79%↑` 或 ` -2.49%↓`
   * @param changeRate 涨跌幅（百分比，如 4.79 表示 +4.79%）
   * @param isETF 是否为 ETF
   */
  private _formatChangeRate(changeRate: number, isETF: boolean): string {
    const decimals = isETF ? 3 : 2;
    const absRate = Math.abs(changeRate).toFixed(decimals);
    const sign = changeRate >= 0 ? '+' : '-';
    const arrow = changeRate >= 0 ? '↑' : '↓';
    return ` ${sign}${absRate}%${arrow}`;
  }

  /**
   * 获取装饰颜色
   * 正常模式：上涨红色，下跌绿色
   * 隐蔽模式：使用注释颜色（灰绿色，与代码注释融为一体）
   * @param changeRate 涨跌幅
   */
  private _getDecorationColor(changeRate: number): string | vscode.ThemeColor {
    if (this.stealthMode) {
      // 隐蔽模式：使用编辑器注释前景色，任何主题下都与注释融为一体
      return new vscode.ThemeColor('editorCodeLens.foreground');
    }
    // 正常模式：上涨红色，下跌绿色
    return changeRate >= 0 ? COLOR_UP : COLOR_DOWN;
  }

  /**
   * 为单只股票应用内联装饰
   * @param editor 目标编辑器
   * @param matches 该股票的所有匹配位置
   * @param stockData 股票实时数据
   */
  private _applyStockDecoration(
    editor: vscode.TextEditor,
    matches: CommentMatch[],
    stockData: StockData
  ): void {
    const text = this._buildDecorationText(stockData);
    if (!text) {
      return; // 没有任何勾选项，不显示装饰
    }
    const color = this._getDecorationColor(stockData.changeRate);

    // 创建装饰类型（after 属性实现内联文本）
    const decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: text,
        color: color,
        fontStyle: 'normal',
      },
    });

    // 将匹配位置转换为 vscode.Range
    const ranges: vscode.DecorationOptions[] = matches.map(match => ({
      range: new vscode.Range(
        new vscode.Position(match.range.line, match.range.endChar),
        new vscode.Position(match.range.line, match.range.endChar)
      ),
    }));

    editor.setDecorations(decorationType, ranges);
    this.decorationTypes.push(decorationType);
  }

  /**
   * 为"持仓"关键词应用聚合盈亏装饰
   * 计算所有持仓股票的总盈亏并显示
   * @param editor 目标编辑器
   * @param matches "持仓"关键词的所有匹配位置
   */
  private _applyPositionDecoration(
    editor: vscode.TextEditor,
    matches: CommentMatch[]
  ): void {
    // 构建当前价格映射表
    const priceMap = new Map<string, number>();
    for (const stock of this.stockDataList) {
      priceMap.set(stock.code, stock.currentPrice);
    }

    // 计算持仓总盈亏
    const totalProfit = this.specialKeywordMap.calculatePositionProfit(
      this.stockEntries,
      priceMap
    );

    if (totalProfit === null) {
      // 无持仓数据，不显示装饰
      return;
    }

    // 持仓总盈亏视为个股（两位小数）
    const text = this._formatChangeRate(totalProfit, false);
    const color = this._getDecorationColor(totalProfit);

    const decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: text,
        color: color,
        fontStyle: 'normal',
      },
    });

    const ranges: vscode.DecorationOptions[] = matches.map(match => ({
      range: new vscode.Range(
        new vscode.Position(match.range.line, match.range.endChar),
        new vscode.Position(match.range.line, match.range.endChar)
      ),
    }));

    editor.setDecorations(decorationType, ranges);
    this.decorationTypes.push(decorationType);
  }

  /**
   * 清除编辑器上所有已应用的装饰类型
   * @param editor 目标编辑器
   */
  private _clearDecorations(editor: vscode.TextEditor): void {
    for (const dt of this.decorationTypes) {
      // 清空该装饰类型的所有范围，然后 dispose
      editor.setDecorations(dt, []);
      dt.dispose();
    }
    this.decorationTypes = [];
  }
}
