/**
 * AlertSystem - 股票价格预警系统
 * 负责检查预警条件、触发高强度闪烁提示、弹窗通知和状态栏固定显示
 *
 * 需求参考：5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
 */

import * as vscode from 'vscode';
import { StockData, StockEntry, AlertConfig, AlertHistoryEntry, STORAGE_KEYS } from '../types';

// ─── IAlertSystem 接口 ────────────────────────────────────────────────────────

export interface IAlertSystem {
  /** 检查所有股票的预警条件，满足时触发对应通知 */
  checkAlerts(stocks: StockData[], entries: StockEntry[]): void;
  /** 触发高强度预警：编辑器全行绿色背景闪烁3次 */
  triggerIntenseAlert(stock: StockData): void;
  /** 触发弹窗预警：使用模板渲染后调用 showInformationMessage */
  triggerPopupAlert(stock: StockData, template: string): void;
  /** 释放所有资源 */
  dispose(): void;
}

// ─── AlertSystem 主类 ─────────────────────────────────────────────────────────

export class AlertSystem implements IAlertSystem {
  /** 状态栏预警显示项 */
  private statusBarItem: vscode.StatusBarItem;

  /** 状态栏固定显示的定时器句柄 */
  private statusBarTimer: ReturnType<typeof setTimeout> | null = null;

  /** 已触发预警的股票代码集合（本次运行周期内去重，避免重复触发） */
  private triggeredCodes: Set<string> = new Set();

  /**
   * 构造函数
   * @param context VSCode 扩展上下文（用于 globalState 持久化）
   * @param config 预警配置（mode、popupTemplate、intenseDuration）
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: AlertConfig,
  ) {
    // 创建状态栏预警显示项（优先级较高，显示在左侧）
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      1000,
    );
  }

  // ── IAlertSystem 实现 ─────────────────────────────────────────────────────────

  /**
   * 检查所有股票的预警条件
   * - 当 currentPrice >= targetPrice 时触发预警
   * - 当 |changeRate| >= targetChangeRate 时触发预警
   * - 两个条件均不满足时不触发
   *
   * @param stocks 当前实时股票数据列表
   * @param entries 用户配置的股票条目列表（含 targetPrice/targetChangeRate/alertEnabled）
   */
  checkAlerts(stocks: StockData[], entries: StockEntry[]): void {
    // 构建 code → entry 的快速查找映射
    const entryMap = new Map<string, StockEntry>();
    for (const entry of entries) {
      entryMap.set(entry.code.toLowerCase(), entry);
    }

    for (const stock of stocks) {
      const entry = entryMap.get(stock.code.toLowerCase());

      // 未找到对应条目或未启用预警，跳过
      if (!entry || !entry.alertEnabled) {
        continue;
      }

      // 检查是否满足预警条件
      const shouldAlert = this._shouldTrigger(stock, entry);

      // 价格回落到目标以下时，清除已触发标记，允许下次重新触发
      if (!shouldAlert) {
        this.triggeredCodes.delete(stock.code.toLowerCase());
        continue;
      }

      // 避免同一只股票在短时间内重复触发（本次运行周期内去重）
      if (this.triggeredCodes.has(stock.code.toLowerCase())) {
        continue;
      }
      this.triggeredCodes.add(stock.code.toLowerCase());

      // 记录预警历史
      this._saveAlertHistory(stock);

      // 根据配置的 mode 触发对应预警
      if (this.config.mode === 'intense' || this.config.mode === 'both') {
        this.triggerIntenseAlert(stock);
      }
      if (this.config.mode === 'popup' || this.config.mode === 'both') {
        this.triggerPopupAlert(stock, this.config.popupTemplate);
      }

      // 状态栏固定显示预警信息
      this._showStatusBarAlert(stock);
    }
  }

  /**
   * 触发高强度预警：编辑器全行绿色背景闪烁3次
   * 使用 setInterval 500ms × 6次（交替显示/隐藏）
   *
   * @param stock 触发预警的股票数据
   */
  triggerIntenseAlert(stock: StockData): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    // 找到所有注释行（包括多行注释的中间行）
    const doc = editor.document;
    const commentRanges: vscode.Range[] = [];
    let inBlockComment = false;
    for (let i = 0; i < doc.lineCount; i++) {
      const lineText = doc.lineAt(i).text.trimStart();
      if (inBlockComment) {
        commentRanges.push(doc.lineAt(i).range);
        if (lineText.includes('*/')) { inBlockComment = false; }
      } else if (lineText.startsWith('//') || lineText.startsWith('#') || lineText.startsWith('--') || lineText.startsWith('<!--')) {
        commentRanges.push(doc.lineAt(i).range);
      } else if (lineText.startsWith('/*') || lineText.startsWith('/**')) {
        commentRanges.push(doc.lineAt(i).range);
        if (!lineText.includes('*/')) { inBlockComment = true; }
      } else if (lineText.startsWith('*')) {
        // JSDoc 中间行
        commentRanges.push(doc.lineAt(i).range);
      }
    }
    if (commentRanges.length === 0) { return; }

    const flashDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 0, 0, 0.35)',
      isWholeLine: true,
    });

    const flashCount = this.config.flashCount ?? 3;
    const totalSteps = flashCount * 2; // 每次闪烁 = 显示 + 隐藏
    let count = 0;

    const timer = setInterval(() => {
      if (count % 2 === 0) {
        editor.setDecorations(flashDecoration, commentRanges);
      } else {
        editor.setDecorations(flashDecoration, []);
      }
      count++;
      if (count >= totalSteps) {
        clearInterval(timer);
        editor.setDecorations(flashDecoration, []);
        flashDecoration.dispose();
      }
    }, 400);

    console.log(`[AlertSystem] 高强度预警已触发：${stock.name}（${stock.code}），闪烁${flashCount}次`);
  }

  /**
   * 触发弹窗预警
   * 将模板中的 {name}、{price}、{changeRate} 占位符替换为实际值
   *
   * @param stock 触发预警的股票数据
   * @param template 弹窗内容模板，支持 {name}、{price}、{changeRate} 占位符
   */
  triggerPopupAlert(stock: StockData, template: string): void {
    const message = this._renderTemplate(template, stock);
    vscode.window.showInformationMessage(message);
    console.log(`[AlertSystem] 弹窗预警已触发：${message}`);
  }

  /**
   * 释放所有资源
   * 清除定时器，隐藏并销毁状态栏项
   */
  dispose(): void {
    if (this.statusBarTimer !== null) {
      clearTimeout(this.statusBarTimer);
      this.statusBarTimer = null;
    }
    this.statusBarItem.hide();
    this.statusBarItem.dispose();
    this.triggeredCodes.clear();
    console.log('[AlertSystem] 已释放资源');
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────────────

  /**
   * 判断是否应触发预警
   * - currentPrice >= targetPrice 时触发
   * - |changeRate| >= targetChangeRate 时触发
   * - 两个条件均不满足时不触发
   *
   * @param stock 实时股票数据
   * @param entry 用户配置的股票条目
   * @returns 是否应触发预警
   */
  private _shouldTrigger(stock: StockData, entry: StockEntry): boolean {
    // 检查目标价格条件
    if (entry.targetPrice !== undefined && stock.currentPrice >= entry.targetPrice) {
      return true;
    }

    // 检查目标涨跌幅条件（取绝对值，支持上涨和下跌预警）
    if (
      entry.targetChangeRate !== undefined &&
      Math.abs(stock.changeRate) >= entry.targetChangeRate
    ) {
      return true;
    }

    return false;
  }

  /**
   * 在状态栏固定显示预警信息
   * 持续时间由 AlertConfig.intenseDuration 决定（默认 60 秒）
   *
   * @param stock 触发预警的股票数据
   */
  private _showStatusBarAlert(stock: StockData): void {
    // 清除上一个状态栏定时器（若存在）
    if (this.statusBarTimer !== null) {
      clearTimeout(this.statusBarTimer);
      this.statusBarTimer = null;
    }

    // 格式化涨跌幅显示
    const changeRateStr =
      stock.changeRate >= 0
        ? `+${stock.changeRate.toFixed(2)}%`
        : `${stock.changeRate.toFixed(2)}%`;

    // 设置状态栏文本并显示
    this.statusBarItem.text = `⚠️ ${stock.name} ${stock.currentPrice.toFixed(2)} ${changeRateStr}`;
    this.statusBarItem.tooltip = `股票预警：${stock.name}（${stock.code}）已达目标价/涨跌幅`;
    this.statusBarItem.show();

    // 持续时间到期后自动隐藏（默认 60 秒）
    const durationMs = (this.config.intenseDuration ?? 60) * 1000;
    this.statusBarTimer = setTimeout(() => {
      this.statusBarItem.hide();
      this.statusBarTimer = null;
    }, durationMs);

    console.log(
      `[AlertSystem] 状态栏预警已显示：${stock.name}，持续 ${this.config.intenseDuration ?? 60}s`,
    );
  }

  /**
   * 渲染弹窗模板
   * 将 {name}、{price}、{changeRate} 占位符替换为实际值
   *
   * @param template 模板字符串
   * @param stock 股票数据
   * @returns 渲染后的字符串
   */
  renderTemplate(template: string, stock: StockData): string {
    return this._renderTemplate(template, stock);
  }

  private _renderTemplate(template: string, stock: StockData): string {
    const name = stock.name;
    const price = stock.currentPrice.toFixed(2);
    const changeRate = stock.changeRate.toFixed(2);
    // 使用函数形式的替换，避免替换字符串中的 $& / $` / $' 等特殊模式被误解释
    return template
      .replace(/\{name\}/g, () => name)
      .replace(/\{price\}/g, () => price)
      .replace(/\{changeRate\}/g, () => changeRate);
  }

  /**
   * 将预警记录持久化到 globalState
   * key: vscode-stock-monitor.alertHistory
   *
   * @param stock 触发预警的股票数据
   */
  private _saveAlertHistory(stock: StockData): void {
    try {
      const history =
        this.context.globalState.get<AlertHistoryEntry[]>(STORAGE_KEYS.ALERT_HISTORY) ?? [];

      const newEntry: AlertHistoryEntry = {
        code: stock.code,
        triggeredAt: Date.now(),
        price: stock.currentPrice,
      };

      history.push(newEntry);

      // 异步持久化，不阻塞主流程
      this.context.globalState.update(STORAGE_KEYS.ALERT_HISTORY, history).then(
        () => {},
        err => {
          console.error('[AlertSystem] 持久化预警历史失败:', err);
        },
      );
    } catch (err) {
      console.error('[AlertSystem] 读取/写入预警历史失败:', err);
    }
  }
}
