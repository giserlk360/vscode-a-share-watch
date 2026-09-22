/**
 * StockWebviewView - 股票侧边栏 Webview 视图
 * 替代 StockTreeView + AddStockWebview，在侧边栏内实现：
 *   - 股票列表（名称、代码、别名、买入价、当前价、涨跌幅、编辑/删除）
 *   - 添加/编辑股票表单（内嵌在同一 Webview 中）
 *   - 搜索匹配（输入时调用东方财富搜索 API）
 */

import * as vscode from 'vscode';
import { StockEntry, StockData } from '../types';
import { IStockManager } from '../data/StockManager';
import { IStockDataProvider } from '../data/StockDataProvider';
import { IPriceMonitor } from '../business/PriceMonitor';

export class StockWebviewView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'stockMonitor.stockView';

  /** 涨跌家数刷新间隔（毫秒），低于行情刷新频率以减少请求 */
  private static readonly BREADTH_TTL_MS = 60 * 1000;

  private _view?: vscode.WebviewView;
  private liveDataMap: Map<string, StockData> = new Map();
  /** 缓存的两市涨跌家数 */
  private breadth: { up: number; flat: number; down: number } | null = null;
  private lastBreadthFetchAt = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly stockManager: IStockManager,
    private readonly dataProvider: IStockDataProvider,
    private readonly priceMonitor: IPriceMonitor,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._sendStockList();
          this._sendDisplayOptions();
          break;
        case 'search':
          await this._handleSearch(msg.keyword);
          break;
        case 'addStock':
          await this._handleAdd(msg);
          break;
        case 'addPortfolio':
          await this._handleAddPortfolio(msg);
          break;
        case 'editStock':
          console.log('[StockWebview] received editStock:', JSON.stringify(msg));
          await this._handleEdit(msg);
          break;
        case 'editPortfolio':
          console.log('[StockWebview] received editPortfolio:', JSON.stringify(msg));
          await this._handleEditPortfolio(msg);
          break;
        case 'addWishlist':
          await this._handleAddWishlist(msg);
          break;
        case 'editWishlist':
          console.log('[StockWebview] received editWishlist:', JSON.stringify(msg));
          await this._handleEditWishlist(msg);
          break;
        case 'deleteStock':
          await this._handleDelete(msg.code, msg.fromTab || 'watchlist');
          break;
        case 'deleteStocks':
          await this._handleBatchDelete(msg.codes || [], msg.fromTab || 'watchlist');
          break;
        case 'savePlanMemo':
          await this._handleSavePlanMemo(msg.text);
          break;
        case 'importStocks':
          await this._handleImport(msg.lines);
          break;
        case 'importPortfolio':
          await this._handleImportPortfolio(msg.json);
          break;
        case 'exportStocks':
          await this._handleExport();
          break;
        case 'showKline':
          await this._handleShowKline(msg.code, msg.days ?? 5);
          break;
        case 'saveSortOrder':
          this._handleSaveSortOrder(msg.sortOrder);
          break;
        case 'saveActiveTab':
          this._handleSaveActiveTab(msg.activeTab);
          break;
        case 'filterWishlist':
          await this._handleFilterWishlist();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this._sendStockList(); }
    });
  }

  /** 由 PriceMonitor 调用，更新实时数据并刷新列表 */
  refresh(stocks: StockData[]): void {
    for (const s of stocks) { this.liveDataMap.set(s.code, s); }
    this._sendStockList();
  }

  private _sendStockList(): void {
    if (!this._view) { return; }
    this._maybeRefreshBreadth();
    const settings = this.priceMonitor.getSettings();

    const mapEntry = (e: StockEntry) => {
      const live = this.liveDataMap.get(e.code);
      return {
        code: e.code,
        name: e.name,
        alias: e.alias ?? '',
        purchasePrice: e.purchasePrice,
        shares: e.shares,
        buyDate: e.buyDate ?? '',
        currentPrice: live?.currentPrice,
        closePrice: live?.closePrice,
        changeRate: live?.changeRate,
        isETF: live?.isETF ?? false,
      };
    };

    const watchlist = this.stockManager.getAll().map(mapEntry);
    const portfolio = this.stockManager.getPortfolio().map(mapEntry);
    const wishlist = this.stockManager.getWishlist().map(mapEntry);

    // 收集启用的指数数据
    const customKeywords = settings.customKeywords || {};
    const stockListKw = settings.stockListKeywords || {};
    const indices: Array<{ code: string; name: string; currentPrice?: number; changeRate?: number }> = [];
    for (const [name, enabled] of Object.entries(stockListKw)) {
      if (enabled && customKeywords[name]) {
        const code = customKeywords[name];
        const live = this.liveDataMap.get(code);
        indices.push({
          code,
          name,
          currentPrice: live?.currentPrice,
          changeRate: live?.changeRate,
        });
      }
    }

    this._view.webview.postMessage({ type: 'stockList', watchlist, portfolio, wishlist, indices, breadth: this.breadth, planMemo: this.stockManager.getPlanMemo() });
  }

  /** 按节流间隔刷新两市涨跌家数，成功且数据有变化时重发列表 */
  private _maybeRefreshBreadth(): void {
    const now = Date.now();
    if (this.breadth && now - this.lastBreadthFetchAt < StockWebviewView.BREADTH_TTL_MS) { return; }
    this.lastBreadthFetchAt = now;
    this.dataProvider.fetchMarketBreadth().then(b => {
      if (b.up + b.flat + b.down <= 0) { return; }
      const changed = !this.breadth || this.breadth.up !== b.up || this.breadth.flat !== b.flat || this.breadth.down !== b.down;
      this.breadth = b;
      if (changed) { this._sendStockList(); }
    }).catch(() => { /* 拉取失败时保留旧数据 */ });
  }

  private async _handleSearch(keyword: string): Promise<void> {
    if (!this._view || !keyword || keyword.trim().length === 0) { return; }
    try {
      const results = await this._searchStocks(keyword.trim());
      this._view.webview.postMessage({ type: 'searchResult', results });
    } catch {
      this._view.webview.postMessage({ type: 'searchResult', results: [] });
    }
  }

  private async _searchStocks(input: string): Promise<Array<{code: string; name: string}>> {
    const https = await import('https');
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(input)}&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8`;
    return new Promise((resolve) => {
      const req = https.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const data: any[] = json?.QuotationCodeTable?.Data ?? [];
            const results: Array<{code: string; name: string}> = [];
            for (const item of data) {
              const mkt = Number(item.MktNum);
              // 只保留沪深 A 股：MktNum 1=沪, 0=深
              if (mkt !== 0 && mkt !== 1) { continue; }
              const rawCode = String(item.Code);
              const prefix = mkt === 1 ? 'sh' : 'sz';
              results.push({ code: `${prefix}${rawCode}`, name: String(item.Name) });
              if (results.length >= 10) { break; }
            }
            resolve(results);
          } catch { resolve([]); }
        });
        res.on('error', () => resolve([]));
      });
      req.setTimeout(3000, () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    });
  }

  private async _handleAdd(msg: any): Promise<void> {
    try {
      const entry: StockEntry = {
        code: msg.code,
        name: msg.name,
        alias: msg.alias?.trim() || undefined,
        purchasePrice: msg.purchasePrice > 0 ? msg.purchasePrice : undefined,
        shares: msg.shares > 0 ? msg.shares : undefined,
        buyDate: msg.buyDate || undefined,
        addedAt: Date.now(),
      };
      await this.stockManager.add(entry);
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'addSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleEdit(msg: any): Promise<void> {
    try {
      await this.stockManager.update(msg.code, {
        alias: msg.alias?.trim() || undefined,
        purchasePrice: msg.purchasePrice > 0 ? msg.purchasePrice : undefined,
        shares: msg.shares > 0 ? msg.shares : undefined,
        buyDate: msg.buyDate || undefined,
      });
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'editSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleAddPortfolio(msg: any): Promise<void> {
    try {
      const entry: StockEntry = {
        code: msg.code,
        name: msg.name,
        purchasePrice: msg.purchasePrice > 0 ? msg.purchasePrice : undefined,
        shares: msg.shares > 0 ? msg.shares : undefined,
        buyDate: msg.buyDate || undefined,
        addedAt: Date.now(),
      };
      await this.stockManager.addPortfolio(entry);
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'addSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleEditPortfolio(msg: any): Promise<void> {
    try {
      await this.stockManager.updatePortfolio(msg.code, {
        purchasePrice: msg.purchasePrice > 0 ? msg.purchasePrice : undefined,
        shares: msg.shares > 0 ? msg.shares : undefined,
        buyDate: msg.buyDate || undefined,
      });
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'editSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleAddWishlist(msg: any): Promise<void> {
    try {
      const entry: StockEntry = {
        code: msg.code,
        name: msg.name,
        alias: msg.alias?.trim() || undefined,
        purchasePrice: msg.purchasePrice > 0 ? msg.purchasePrice : undefined,
        shares: msg.shares > 0 ? msg.shares : undefined,
        addedAt: Date.now(),
      };
      await this.stockManager.addWishlist(entry);
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'addSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleEditWishlist(msg: any): Promise<void> {
    try {
      await this.stockManager.updateWishlist(msg.code, {
      });
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'editSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleDelete(code: string, tab: 'watchlist' | 'portfolio' | 'wishlist'): Promise<void> {
    try {
      const entries = tab === 'portfolio' ? this.stockManager.getPortfolio() : tab === 'wishlist' ? this.stockManager.getWishlist() : this.stockManager.getAll();
      const entry = entries.find(e => e.code === code);
      const name = entry?.name || code;
      const answer = await vscode.window.showWarningMessage(
        `确定删除 ${name}（${code}）？`,
        { modal: true },
        '删除'
      );
      if (answer !== '删除') { return; }
      if (tab === 'portfolio') {
        await this.stockManager.removePortfolio(code);
      } else if (tab === 'wishlist') {
        await this.stockManager.removeWishlist(code);
      } else {
        await this.stockManager.remove(code);
      }
      this._sendStockList();
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleBatchDelete(codes: string[], tab: 'watchlist' | 'portfolio' | 'wishlist'): Promise<void> {
    try {
      if (codes.length === 0) { return; }
      const answer = await vscode.window.showWarningMessage(
        `确定删除选中的 ${codes.length} 只股票？`,
        { modal: true },
        '删除'
      );
      if (answer !== '删除') { return; }
      for (const code of codes) {
        if (tab === 'portfolio') {
          await this.stockManager.removePortfolio(code);
        } else if (tab === 'wishlist') {
          await this.stockManager.removeWishlist(code);
        } else {
          await this.stockManager.remove(code);
        }
      }
      this._sendStockList();
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  /** 手动触发回调股筛选：从自选股中筛选并加入预购股 */
  private async _handleFilterWishlist(): Promise<void> {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在筛选回调股...' },
        () => this.priceMonitor.filterWishlistNow(),
      );
      if (result.added.length === 0) {
        vscode.window.showInformationMessage('筛选完成：未发现符合条件的回调股（多维度回调评分未达门槛）');
      } else {
        let msg = `筛选完成：${result.added.length} 只加入预购股（${result.added.join('、')}）`;
        if (result.droppedByCap > 0) {
          msg += `；另有 ${result.droppedByCap} 只达标但按评分排序未入选`;
        }
        vscode.window.showInformationMessage(msg);
      }
      this._sendStockList();
    } catch (err) {
      vscode.window.showErrorMessage(`筛选预购股失败：${(err as Error).message}`);
    }
  }

  private async _handleSavePlanMemo(text: string): Promise<void> {
    try {
      await this.stockManager.savePlanMemo(text || '');
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleImport(lines: string[]): Promise<void> {
    if (!this._view) { return; }

    const resolved: Array<{ code: string; name: string }> = [];
    const failed: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      // 判断是代码还是名称
      const codeRegex = /^(sh|sz)?\d{6}$/i;
      if (codeRegex.test(trimmed)) {
        // 代码行：标准化前缀，再搜索获取名称
        const normalizedCode = this.dataProvider.resolveMarketPrefix(trimmed);
        try {
          const pureDigits = normalizedCode.replace(/^(sh|sz)/i, '');
          const searchResults = await this._searchStocks(pureDigits);
          const exact = searchResults.find(r => r.code.toLowerCase() === normalizedCode.toLowerCase());
          if (exact) {
            resolved.push({ code: exact.code, name: exact.name });
          } else if (searchResults.length > 0) {
            resolved.push({ code: searchResults[0].code, name: searchResults[0].name });
          } else {
            resolved.push({ code: normalizedCode, name: normalizedCode });
          }
        } catch {
          resolved.push({ code: normalizedCode, name: normalizedCode });
        }
      } else {
        // 名称行：搜索 API 查找
        try {
          const searchResults = await this._searchStocks(trimmed);
          if (searchResults.length > 0) {
            resolved.push({ code: searchResults[0].code, name: searchResults[0].name });
          } else {
            failed.push(trimmed);
          }
        } catch {
          failed.push(trimmed);
        }
      }
      // 每次请求后短暂延迟，避免 API 限流
      await new Promise(r => setTimeout(r, 200));
    }

    // 构造 StockEntry 数组
    const entries: StockEntry[] = resolved.map(r => ({
      code: r.code,
      name: r.name,
      addedAt: Date.now(),
    }));

    // 调用批量添加
    const batchResult = await this.stockManager.addBatch(entries);

    // 合并解析失败和批量添加失败的结果
    const mergedResult = {
      added: batchResult.added,
      skipped: batchResult.skipped,
      failed: batchResult.failed + failed.length,
      errors: [...batchResult.errors, ...failed.map(f => `未找到: ${f}`)],
    };

    // 刷新列表
    this._sendStockList();

    // 发送结果回 webview
    this._view.webview.postMessage({ type: 'importResult', result: mergedResult });
  }

  private async _handleExport(): Promise<void> {
    const settings = this.priceMonitor.getSettings();
    const activeTab = settings.stockListDisplay?.activeTab || 'watchlist';

    // 持有股 tab：导出持有股完整数据
    if (activeTab === 'portfolio') {
      const entries = this.stockManager.getPortfolio();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('暂无持有股可导出');
        return;
      }

      const content = this.stockManager.exportPortfolioJSON();
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('portfolio-export.json'),
        title: '导出持有股',
        filters: { 'JSON': ['json'] },
      });
      if (!uri) { return; }
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
      vscode.window.showInformationMessage(`已导出 ${entries.length} 只持有股到 ${uri.fsPath}`);
      return;
    }

    // 自选股 / 预购股：原逻辑
    const entries = this.stockManager.getAll();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('暂无股票可导出');
      return;
    }

    // 选择导出格式
    const format = await vscode.window.showQuickPick([
      { label: '代码', description: '每行一个股票代码（如 sh600036）' },
      { label: '名称', description: '每行一个股票名称（如 招商银行）' },
      { label: '代码 + 名称', description: '每行代码和名称（如 sh600036 招商银行）' },
      { label: 'JSON 完整数据', description: '包含所有字段的 JSON 格式，可用于导入还原' },
    ], { placeHolder: '选择导出格式' });
    if (!format) { return; }

    let content: string;
    let ext: string;
    const stocks = entries.map(e => {
      const code = e.code.startsWith('sh') || e.code.startsWith('sz')
        ? e.code.replace(/^(sh|sz)/i, '') : e.code;
      return { code, name: e.name };
    });

    switch (format.label) {
      case '代码':
        content = stocks.map(s => s.code).join('\n');
        ext = 'txt';
        break;
      case '名称':
        content = stocks.map(s => s.name).join('\n');
        ext = 'txt';
        break;
      case '代码 + 名称':
        content = stocks.map(s => s.code + ' ' + s.name).join('\n');
        ext = 'txt';
        break;
      case 'JSON 完整数据':
      default:
        content = this.stockManager.exportJSON();
        ext = 'json';
        break;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`stock-export.${ext}`),
      title: '导出自选股',
      filters: ext === 'json' ? { 'JSON': ['json'] } : { '文本': ['txt'] },
    });
    if (!uri) { return; }
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    vscode.window.showInformationMessage(`已导出 ${entries.length} 只股票到 ${uri.fsPath}`);
  }

  private async _handleImportPortfolio(json: string): Promise<void> {
    if (!this._view) { return; }

    try {
      const result = await this.stockManager.importPortfolioJSON(json);
      this._view.webview.postMessage({ type: 'importResult', result });
    } catch (err) {
      this._view.webview.postMessage({ type: 'importResult', result: { added: 0, skipped: 0, failed: 0, errors: [(err as Error).message] } });
    }
  }

  private async _handleShowKline(code: string, days: number = 5): Promise<void> {
    if (!this._view) { return; }
    try {
      // days === 0 表示当日分时
      const minute = days === 0;
      const kline = minute
        ? await this.dataProvider.fetchMinute(code)
        : await this.dataProvider.fetchKline(code, days);
      const live = this.liveDataMap.get(code);
      const name = live?.name || this.stockManager.getByCode(code)?.name || code;
      this._view.webview.postMessage({
        type: 'klineData',
        mode: minute ? 'minute' : 'day',
        data: kline,
        name,
        code,
        days,
        baseline: live?.closePrice,
      });
    } catch (e) {
      console.error('[StockWebview] showKline error:', e);
      this._view?.webview.postMessage({ type: 'error', text: '获取走势数据失败' });
    }
  }

  private _handleSaveSortOrder(sortOrder: 'desc' | 'asc' | null): void {
    const settings = this.priceMonitor.getSettings();
    const display = settings.stockListDisplay || {};
    this.priceMonitor.updateSettings({
      stockListDisplay: { ...display, sortOrder },
    });
  }

  private _handleSaveActiveTab(activeTab: 'watchlist' | 'wishlist' | 'portfolio'): void {
    const settings = this.priceMonitor.getSettings();
    const display = settings.stockListDisplay || {};
    this.priceMonitor.updateSettings({
      stockListDisplay: { ...display, activeTab },
    });
  }

  private _sendDisplayOptions(): void {
    if (!this._view) { return; }
    const settings = this.priceMonitor.getSettings();
    const options = settings.stockListDisplay || {
      showCode: true,
      showCurrentPrice: true,
      showChangeRate: true,
      showPurchasePrice: true,
      showShares: true,
      showProfit: true,
    };
    this._view.webview.postMessage({ type: 'displayOptions', options });
  }

  private _buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--sm-border:var(--vscode-widget-border);--sm-panel:var(--vscode-editor-background);--sm-hover:var(--vscode-list-hoverBackground);--sm-muted:var(--vscode-descriptionForeground)}
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;overflow:hidden;height:100vh}
#listView{display:flex;flex-direction:column;height:100vh;min-width:0}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--sm-border);background:var(--vscode-sideBar-background)}
.toolbar-title{font-size:11px;font-weight:700;color:var(--vscode-foreground);opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toolbar-btn{min-width:28px;height:24px;background:transparent;border:1px solid transparent;color:var(--vscode-foreground);cursor:pointer;font-size:12px;padding:0 6px;border-radius:4px;opacity:.75;line-height:22px}
.toolbar-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);border-color:var(--sm-border)}
.toolbar-btn:active{transform:translateY(1px)}
.stock-list{padding:4px 0;flex:1;overflow-y:auto;min-height:0}
.stock-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--sm-border);cursor:default;min-height:54px}
.stock-index{background:var(--sm-panel);opacity:.92}
.stock-item:hover{background:var(--sm-hover)}
/* 两市涨跌家数 */
.breadth-box{padding:6px 10px 7px;border-bottom:1px solid var(--sm-border)}
.breadth-row{display:flex;align-items:baseline;gap:12px;font-size:11px;font-variant-numeric:tabular-nums}
.br-item{font-weight:700}
.br-flat{color:var(--sm-muted);font-weight:600}
.br-total{margin-left:auto;color:var(--sm-muted);font-size:10px;font-weight:400}
.breadth-bar{display:flex;height:3px;border-radius:2px;overflow:hidden;margin-top:5px}
.bb-up{background:#F14C4C}
.bb-flat{background:var(--vscode-descriptionForeground);opacity:.55}
.bb-down{background:#73C991}
.stock-info{flex:1;min-width:0}
.stock-name{font-size:12px;font-weight:700;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stock-alias{font-size:10px;color:var(--sm-muted);margin-left:4px;font-weight:400}
.stock-code{font-size:10px;color:var(--sm-muted)}
.stock-prices{display:flex;align-items:baseline;gap:7px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stock-current{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.stock-change{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.stock-purchase{font-size:10px;color:var(--sm-muted)}
.stock-shares{font-size:10px;color:var(--sm-muted);margin-top:3px;white-space:nowrap}
.stock-profit{font-size:10px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
.total-bar{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-top:1px solid var(--sm-border);background:var(--sm-panel);font-size:11px;min-height:30px}
.total-label{font-weight:700;opacity:.78}
.total-value{font-weight:800;font-size:12px;font-variant-numeric:tabular-nums}
.up{color:#F14C4C}
.down{color:#73C991}
.stock-actions{display:flex;gap:2px;opacity:0;transition:opacity .12s;flex:0 0 auto}
.stock-item:hover .stock-actions{opacity:1}
.act-btn{width:23px;height:23px;background:transparent;border:1px solid transparent;color:var(--vscode-foreground);cursor:pointer;font-size:12px;padding:0;border-radius:4px;opacity:.68;line-height:21px;text-align:center}
.act-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground);border-color:var(--sm-border)}
/* 多选模式 */
.stock-check{flex:0 0 auto;width:15px;height:15px;border:1px solid var(--vscode-checkbox-border);border-radius:3px;background:var(--vscode-checkbox-background);color:var(--vscode-checkbox-foreground);font-size:10px;line-height:13px;text-align:center;cursor:pointer;user-select:none}
.stock-check.checked{background:var(--vscode-checkbox-selectBackground);border-color:var(--vscode-checkbox-selectBorder)}
.stock-check.checked::after{content:'✓'}
.select-mode .stock-actions{display:none}
.select-mode .stock-item{cursor:pointer}
.select-mode .stock-item.selected{background:var(--vscode-list-inactiveSelectionBackground)}
.empty{text-align:center;padding:28px 12px;color:var(--sm-muted);font-size:11px;line-height:1.6}
/* 添加/编辑表单 */
.form-overlay{display:none;padding:12px;background:var(--vscode-sideBar-background);min-height:100vh}
.form-overlay.active{display:block}
.form-title{font-size:13px;font-weight:700;margin-bottom:12px}
.field{margin-bottom:11px}
.field label{display:block;font-size:11px;color:var(--vscode-foreground);margin-bottom:5px;font-weight:600;opacity:.84}
.field input{width:100%;height:28px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:5px 8px;outline:none;border-radius:3px}
.field input:focus{border-color:var(--vscode-focusBorder)}
.field input::placeholder{color:var(--vscode-input-placeholderForeground)}
.search-results{border:1px solid var(--sm-border);background:var(--vscode-dropdown-background);max-height:168px;overflow-y:auto;display:none;border-radius:4px;margin-top:4px}
.search-results.active{display:block}
.search-item{padding:7px 8px;cursor:pointer;font-size:11px;display:flex;justify-content:space-between;gap:8px}
.search-item:hover{background:var(--sm-hover)}
.search-item .si-name{font-weight:500}
.search-item .si-code{color:var(--sm-muted);font-variant-numeric:tabular-nums}
.hint{font-size:10px;color:var(--sm-muted);margin-top:3px;line-height:1.4}
.form-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.btn{height:28px;padding:0 14px;font-size:11px;border:none;cursor:pointer;border-radius:3px;font-weight:600}
.btn-cancel{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.btn:hover{opacity:.85}
.form-error{color:var(--vscode-errorForeground);font-size:11px;margin-top:6px;display:none}
/* Tab 栏 */
.tab-bar{display:flex;gap:2px;padding:6px 8px 5px;border-bottom:1px solid var(--sm-border);background:var(--sm-panel)}
.tab-btn{flex:1;height:27px;font-size:11px;font-weight:600;background:transparent;border:1px solid transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.72;transition:opacity .12s,background .12s,border-color .12s;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tab-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.tab-btn.active{opacity:1;background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:transparent}
.sort-active{color:var(--vscode-focusBorder)!important;opacity:1!important}
/* 导入弹窗 */
#importView textarea{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:7px 8px;outline:none;resize:vertical;font-family:var(--vscode-font-family);line-height:1.45;border-radius:3px}
#importView textarea:focus{border-color:var(--vscode-focusBorder)}
#importView textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
.import-result{font-size:11px;padding:8px;background:var(--vscode-input-background);border:1px solid var(--sm-border);border-radius:4px;margin-bottom:8px;line-height:1.5}
.ir-ok{color:#73C991}
.ir-skip{color:var(--sm-muted)}
.ir-fail{color:var(--vscode-errorForeground)}
.import-progress{padding:4px 0;margin-bottom:4px}
/* 走势图 */
#klineChart{position:relative}
#klineChart svg{width:100%;height:auto;display:block}
.kline-tip{position:absolute;display:none;pointer-events:none;background:var(--vscode-dropdown-background);border:1px solid var(--sm-border);border-radius:4px;padding:5px 8px;font-size:10px;line-height:1.6;z-index:10;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.kline-tip .kt-date{font-weight:700;margin-bottom:1px}
.kline-legend{display:flex;gap:12px;justify-content:center;font-size:10px;color:var(--sm-muted);margin-bottom:2px}
.kl-sw{display:inline-block;width:12px;height:2px;border-radius:1px;vertical-align:middle;margin-right:4px}
.kline-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.kline-dot{stroke-width:2;fill:var(--vscode-sideBar-background)}
.kline-date{fill:var(--sm-muted);font-size:9px;font-family:var(--vscode-font-family)}
.kline-price{fill:var(--sm-muted);font-size:9px;font-family:var(--vscode-font-family)}
.kline-info{font-size:10px;color:var(--sm-muted);text-align:center;margin-top:6px;line-height:1.6}
.kline-period{height:24px;padding:0 10px;font-size:10px;opacity:.65;background:transparent;border:1px solid var(--sm-border);color:var(--vscode-foreground);cursor:pointer;border-radius:4px}
.kline-period.active{opacity:1;border-color:var(--vscode-focusBorder)}
/* 明日计划备忘录 */
.plan-memo{border-top:1px solid var(--sm-border);padding:9px 10px 10px;background:var(--vscode-sideBar-background)}
.plan-memo-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.plan-memo-title{font-size:11px;font-weight:700;color:var(--vscode-foreground);opacity:.84}
.plan-memo-save{height:24px;background:var(--vscode-button-background);border:1px solid transparent;color:var(--vscode-button-foreground);cursor:pointer;font-size:11px;padding:0 10px;border-radius:3px;line-height:22px;flex:0 0 auto;font-weight:600}
.plan-memo-save:hover{opacity:.88}
#planMemoInput{width:100%;min-height:64px;max-height:150px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:7px 8px;outline:none;resize:vertical;font-family:var(--vscode-font-family);line-height:1.45;border-radius:4px}
#planMemoInput:focus{border-color:var(--vscode-focusBorder)}
#planMemoInput::placeholder{color:var(--vscode-input-placeholderForeground)}
</style>
</head>
<body>
<div id="listView">
  <div class="tab-bar">
    <button class="tab-btn active" id="tabWatchlist" data-tab="watchlist">自选股</button>
    <button class="tab-btn" id="tabWishlist" data-tab="wishlist">预购股</button>
    <button class="tab-btn" id="tabPortfolio" data-tab="portfolio">持有股</button>
  </div>
  <div class="toolbar">
    <span class="toolbar-title" id="toolbarTitle">自选股</span>
    <div class="toolbar-actions">
      <button class="toolbar-btn" id="selectAllBtn" title="全选/取消全选" style="display:none">全选</button>
      <button class="toolbar-btn" id="delSelBtn" title="删除所选" style="display:none">删除(0)</button>
      <button class="toolbar-btn" id="cancelSelBtn" title="退出多选" style="display:none">取消</button>
      <button class="toolbar-btn" id="selectBtn" title="多选删除">☑️</button>
      <button class="toolbar-btn" id="sortBtn" title="按涨跌幅排序">↕️</button>
      <button class="toolbar-btn" id="exportBtn" title="导出">📤</button>
      <button class="toolbar-btn" id="importBtn" title="导入">📥</button>
      <button class="toolbar-btn" id="filterBtn" title="从自选股中筛选回调股加入预购股（多维度评分排序，仅取评分最高的若干只）" style="display:none">🔍</button>
      <button class="toolbar-btn" id="addBtn" title="添加股票">➕</button>
    </div>
  </div>
  <div id="stockList" class="stock-list"></div>
  <div id="dailyProfitBar" class="total-bar" style="display:none">
    <span class="total-label">当日盈亏</span>
    <span id="dailyProfitValue" class="total-value"></span>
  </div>
  <div id="totalBar" class="total-bar" style="display:none">
    <span class="total-label">总盈亏</span>
    <span id="totalValue" class="total-value"></span>
  </div>
  <div id="totalAmountBar" class="total-bar" style="display:none">
    <span class="total-label">总市值</span>
    <span id="totalAmountValue" class="total-value"></span>
  </div>
  <div class="plan-memo">
    <div class="plan-memo-head">
      <div class="plan-memo-title">明日计划</div>
      <button class="plan-memo-save" id="planMemoSaveBtn" title="保存明日计划">保存</button>
    </div>
    <textarea id="planMemoInput" rows="3" placeholder="手动输入明日计划，像备忘录一样记录..."></textarea>
  </div>
</div>
<div id="formView" class="form-overlay">
  <div class="form-title" id="formTitle">添加股票</div>
  <div class="field" id="codeField">
    <label>股票代码/名称</label>
    <input id="codeInput" placeholder="输入代码或名称搜索..." autocomplete="off">
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="field" id="aliasField">
    <label>别名（可选）</label>
    <input id="aliasInput" placeholder="自定义别名...">
  </div>
  <div class="field" id="priceField">
    <label>买入价格（可选）</label>
    <input id="priceInput" type="number" min="0" step="0.01" placeholder="买入价格">
  </div>
  <div class="field" id="sharesField">
    <label>持仓数量（可选，须为100的倍数）</label>
    <input id="sharesInput" type="number" min="0" step="100" placeholder="如: 100, 200...">
    <div class="hint">A股最小交易单位为100股（1手）</div>
  </div>
  <div class="field" id="buyDateField">
    <label>买入日期（可选）</label>
    <input id="buyDateInput" type="date">
    <div class="hint">当天买入的股票，当日盈亏按（现价−买入价）计算；其他日期或留空按昨收计算</div>
  </div>
  <div class="form-error" id="formError"></div>
  <div class="form-btns">
    <button class="btn btn-cancel" id="cancelBtn">取消</button>
    <button class="btn btn-ok" id="okBtn">确定</button>
  </div>
</div>
<div id="importView" class="form-overlay">
  <div class="form-title">批量导入股票</div>
  <div class="field">
    <label>股票代码/名称（每行一个）</label>
    <textarea id="importInput" rows="8" placeholder="支持格式：&#10;sh600036&#10;000001&#10;招商银行&#10;&#10;每行一只股票，支持代码或名称"></textarea>
    <div class="hint">支持6位数字代码（如600036）、带前缀代码（如sh600036）或股票名称</div>
  </div>
  <div id="importProgress" class="import-progress" style="display:none">
    <span class="toolbar-title">正在导入，请稍候...</span>
  </div>
  <div id="importResult" class="import-result" style="display:none"></div>
  <div class="form-error" id="importError" style="display:none"></div>
  <div class="form-btns">
    <button class="btn btn-cancel" id="importCancelBtn">取消</button>
    <button class="btn btn-ok" id="importOkBtn">导入</button>
  </div>
</div>
<div id="importPortfolioView" class="form-overlay">
  <div class="form-title">导入持有股</div>
  <div class="field">
    <label>持有股 JSON 数据</label>
    <textarea id="importPortfolioInput" rows="8" placeholder="粘贴从导出获得的持有股 JSON 数据..."></textarea>
    <div class="hint">支持从持有股导出的 JSON 文件内容粘贴导入，已有股票将跳过</div>
  </div>
  <div id="importPortfolioResult" class="import-result" style="display:none"></div>
  <div class="form-error" id="importPortfolioError" style="display:none"></div>
  <div class="form-btns">
    <button class="btn btn-cancel" id="importPortfolioCancelBtn">取消</button>
    <button class="btn btn-ok" id="importPortfolioOkBtn">导入</button>
  </div>
</div>
<div id="klineView" class="form-overlay">
  <div class="form-title" id="klineTitle">股价走势</div>
  <div style="display:flex;gap:8px;margin-bottom:8px">
    <button class="btn btn-ok kline-period active" data-days="0">分时</button>
    <button class="btn btn-ok kline-period" data-days="5">5日</button>
    <button class="btn btn-ok kline-period" data-days="10">10日</button>
    <button class="btn btn-ok kline-period" data-days="20">20日</button>
  </div>
  <div id="klineLoading" style="text-align:center;padding:20px;color:var(--vscode-descriptionForeground);font-size:11px">加载中...</div>
  <div id="klineChart"></div>
  <div id="klineInfo" class="kline-info"></div>
  <div class="form-btns">
    <button class="btn btn-cancel" id="klineCloseBtn">关闭</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

let editCode = null; // 非 null 时为编辑模式
let selectedResult = null; // 搜索选中的结果 {code, name}
let searchTimer = null;
let planMemoDirty = false;
let planMemoSaving = false;
let displayOpts = { showCode:true, showCurrentPrice:true, showChangeRate:true, showPurchasePrice:true, showShares:true, showProfit:true, showPositionChangeRate:false, showPositionAmount:false };
let activeTab = 'watchlist'; // 当前激活的 Tab
let allWatchlistData = null;   // 缓存自选股数据
let allPortfolioData = null;   // 缓存持有股数据
let allWishlistData = null;   // 缓存预购股数据
let planMemoText = '';        // 缓存明日计划备忘录
let klineDays = 0;             // 走势图天数（5/10/20；0=当日分时，默认分时）
let klineCode = '';            // 当前走势图股票代码
let klineName = '';            // 当前走势图股票名称
let klineMode = 'day';         // day=日K，minute=分时
let klineBaseline = 0;         // 分时昨收基准价
let allIndicesData = null;   // 缓存指数数据
let allBreadthData = null;   // 缓存两市涨跌家数
let sortOrder = null;         // null=默认, 'desc'=涨幅优先, 'asc'=跌幅优先
let formTab = 'watchlist';    // 当前表单操作的 Tab 来源
let selectMode = false;       // 多选模式
let selectedCodes = new Set(); // 多选模式选中的股票代码

// ── 消息处理 ──
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'stockList') {
    allWatchlistData = msg.watchlist;
    allPortfolioData = msg.portfolio;
    allWishlistData = msg.wishlist;
    planMemoText = msg.planMemo || '';
    if (!planMemoDirty && !planMemoSaving && $('planMemoInput').value !== planMemoText) {
      $('planMemoInput').value = planMemoText;
    }
    allIndicesData = msg.indices || [];
    allBreadthData = msg.breadth || null;
    renderList(msg, activeTab);
  }
  if (msg.type === 'searchResult') renderSearchResults(msg.results);
  if (msg.type === 'addSuccess' || msg.type === 'editSuccess') { showList(); }
  if (msg.type === 'error') {
    const errDiv = $('importPortfolioView').classList.contains('active') ? $('importPortfolioError') : $('importView').classList.contains('active') ? $('importError') : $('formError');
    errDiv.textContent = msg.text;
    errDiv.style.display = 'block';
  }
  if (msg.type === 'displayOptions') applyDisplayOptions(msg.options);
  if (msg.type === 'importResult') showImportResult(msg);
  if (msg.type === 'klineData') {
    klineCode = msg.code;
    klineName = msg.name;
    klineDays = msg.days ?? 5;
    klineMode = msg.mode || 'day';
    klineBaseline = msg.baseline || 0;
    showKline();
    if (klineMode === 'minute') {
      renderMinuteChart(msg.data, msg.name, msg.code, klineBaseline);
    } else {
      renderKlineChart(msg.data, msg.name, msg.code, klineDays);
    }
  }
});

// ── 显示设置（由插件设置面板控制） ──
function applyDisplayOptions(opts) {
  if (!opts) return;
  displayOpts = { ...displayOpts, ...opts };
  // 恢复排序状态
  if (opts.sortOrder !== undefined) {
    sortOrder = opts.sortOrder;
    $('sortBtn').classList.toggle('sort-active', sortOrder !== null);
    $('sortBtn').textContent = sortOrder === 'desc' ? '⬇️' : sortOrder === 'asc' ? '⬆️' : '↕️';
  }
  // 恢复 Tab 状态
  if (opts.activeTab) {
    const savedTab = ['watchlist', 'wishlist', 'portfolio'].includes(opts.activeTab) ? opts.activeTab : 'watchlist';
    activeTab = savedTab;
    switchTab(savedTab);
  }
}

// ── 渲染股票列表 ──
// ── 两市涨跌家数（列表置顶） ──
function buildBreadthHtml(b) {
  const total = b.up + b.flat + b.down;
  const pct = v => (v / total * 100).toFixed(2);
  return '<div class="breadth-box">'
    + '<div class="breadth-row">'
    + '<span class="br-item up">红 ' + b.up + '</span>'
    + '<span class="br-item br-flat">平 ' + b.flat + '</span>'
    + '<span class="br-item down">绿 ' + b.down + '</span>'
    + '<span class="br-total">共' + total + '家</span>'
    + '</div>'
    + '<div class="breadth-bar">'
    + '<span class="bb-up" style="width:' + pct(b.up) + '%"></span>'
    + '<span class="bb-flat" style="width:' + pct(b.flat) + '%"></span>'
    + '<span class="bb-down" style="width:' + pct(b.down) + '%"></span>'
    + '</div>'
    + '</div>';
}

function renderList(msg, tab) {
  tab = tab || 'watchlist';
  let list = tab === 'portfolio' ? (msg.portfolio || []) : tab === 'wishlist' ? (msg.wishlist || []) : (msg.watchlist || []);
  const indices = msg.indices || [];
  const b = msg.breadth;
  const breadthHtml = (b && b.up + b.flat + b.down > 0) ? buildBreadthHtml(b) : '';

  // 按涨跌幅排序
  if (sortOrder === 'desc' || sortOrder === 'asc') {
    list = [...list].sort((a, b) => {
      const ra = a.changeRate ?? 0;
      const rb = b.changeRate ?? 0;
      return sortOrder === 'desc' ? rb - ra : ra - rb;
    });
  }

  // 多选模式：清掉已不在列表中的选中项，并刷新工具栏计数
  if (selectMode) {
    const valid = new Set(list.map(s => s.code));
    selectedCodes = new Set([...selectedCodes].filter(c => valid.has(c)));
    updateSelectToolbar();
  }
  const container = $('stockList');
  const dailyProfitBar = $('dailyProfitBar');
  const totalBar = $('totalBar');
  const totalAmountBar = $('totalAmountBar');
  if ((!list || list.length === 0) && indices.length === 0 && !breadthHtml) {
    container.innerHTML = '';
    dailyProfitBar.style.display = 'none';
    totalBar.style.display = 'none';
    totalAmountBar.style.display = 'none';
    return;
  }

  // 渲染指数行（置顶）
  let indexHtml = '';
  if (indices.length > 0) {
    indexHtml = indices.map(s => {
      const hasLive = s.currentPrice !== undefined && s.currentPrice !== null;
      const rate = s.changeRate ?? 0;
      const cls = rate >= 0 ? 'up' : 'down';
      const sign = rate >= 0 ? '+' : '';
      const priceStr = hasLive ? s.currentPrice.toFixed(2) : '--';
      const rateStr = hasLive ? sign + rate.toFixed(2) + '%' : '';
      let priceParts = '';
      if (displayOpts.showCode) priceParts += '<span class="stock-code">' + esc(s.code) + '</span>';
      if (displayOpts.showCurrentPrice && hasLive) priceParts += ' <span class="stock-current ' + cls + '">' + priceStr + '</span>';
      if (displayOpts.showChangeRate && hasLive) priceParts += ' <span class="stock-change ' + cls + '">' + rateStr + '</span>';
      return '<div class="stock-item stock-index">'
        + '<div class="stock-info">'
        + '<div><span class="stock-name">' + esc(s.name) + '</span></div>'
        + (priceParts ? '<div class="stock-prices">' + priceParts + '</div>' : '')
        + '</div></div>';
    }).join('');
  }

  let totalProfit = 0;
  let totalAmount = 0;
  let totalDailyProfit = 0;
  let hasAnyPosition = false;

  const stockHtml = list.map(s => {
    const hasLive = s.currentPrice !== undefined && s.currentPrice !== null;
    const rate = s.changeRate ?? 0;
    const cls = rate >= 0 ? 'up' : 'down';
    const sign = rate >= 0 ? '+' : '';
    const decimals = s.isETF ? 3 : 2;
    const priceDecimals = s.isETF ? 3 : 2;
    const priceStr = hasLive ? s.currentPrice.toFixed(priceDecimals) : '--';
    const rateStr = hasLive ? sign + rate.toFixed(decimals) + '%' : '';
    const aliasStr = s.alias ? '<span class="stock-alias">(' + esc(s.alias) + ')</span>' : '';
    const purchaseStr = s.purchasePrice ? '买入:' + s.purchasePrice.toFixed(priceDecimals) : '';

    // 股数和单只持仓盈亏（始终计算总盈亏，但按显示选项控制是否渲染）
    let sharesHtml = '';
    let profitHtml = '';
    if (s.shares && s.shares > 0) {
      if (hasLive) totalAmount += s.currentPrice * s.shares;
      if (displayOpts.showShares) {
        sharesHtml = '<span class="stock-shares">股数: ' + s.shares + '</span>';
      }
      if (hasLive && s.purchasePrice && s.purchasePrice > 0) {
        const singleProfit = (s.currentPrice - s.purchasePrice) * s.shares;
        totalProfit += singleProfit;
        hasAnyPosition = true;
        // 当日盈亏：当日买入按（现价−买入价），隔日持仓按（现价−昨收）
        if (s.closePrice && s.closePrice > 0) {
          const boughtToday = !!s.buyDate && s.buyDate === localDateStr(new Date());
          const dailyBase = boughtToday ? s.purchasePrice : s.closePrice;
          totalDailyProfit += (s.currentPrice - dailyBase) * s.shares;
        }
        if (displayOpts.showProfit) {
          const profitCls = singleProfit >= 0 ? 'up' : 'down';
          const profitSign = singleProfit >= 0 ? '+' : '-';
          profitHtml = '<span class="stock-profit ' + profitCls + '">盈亏: ' + profitSign + Math.abs(singleProfit).toFixed(2) + '</span>';
        }
        if (displayOpts.showPositionChangeRate) {
          const posRate = (s.currentPrice - s.purchasePrice) / s.purchasePrice * 100;
          const posCls = posRate >= 0 ? 'up' : 'down';
          const posSign = posRate >= 0 ? '+' : '';
          profitHtml += ' <span class="stock-profit ' + posCls + '">持仓:' + posSign + posRate.toFixed(2) + '%</span>';
        }
      }
      if (displayOpts.showPositionAmount && hasLive && s.shares && s.shares > 0) {
        const amount = s.currentPrice * s.shares;
        profitHtml += ' <span class="stock-shares">市值:' + amount.toFixed(2) + '</span>';
      }
    }

    // 按显示选项拼装价格行
    let priceParts = '';
    if (displayOpts.showCode) priceParts += '<span class="stock-code">' + esc(s.code) + '</span>';
    if (displayOpts.showCurrentPrice && hasLive) priceParts += ' <span class="stock-current ' + cls + '">' + priceStr + '</span>';
    if (displayOpts.showChangeRate && hasLive) priceParts += ' <span class="stock-change ' + cls + '">' + rateStr + '</span>';
    if (displayOpts.showPurchasePrice && purchaseStr) priceParts += ' <span class="stock-purchase">' + purchaseStr + '</span>';

    // 按钮配置：自选股=走势+预购+删除，预购股=走势+删除，持有股=走势+编辑+删除
    const actionBtns = activeTab === 'portfolio'
      ? '<button class="act-btn kline-btn" title="走势">📈</button>'
        + '<button class="act-btn edit-btn" title="编辑">✎</button>'
        + '<button class="act-btn del-btn" title="删除">✕</button>'
      : activeTab === 'wishlist'
        ? '<button class="act-btn kline-btn" title="走势">📈</button>'
          + '<button class="act-btn del-btn" title="删除">✕</button>'
        : '<button class="act-btn kline-btn" title="走势">📈</button>'
          + '<button class="act-btn wish-btn" title="预购">☆</button>'
          + '<button class="act-btn del-btn" title="删除">✕</button>';

    const checked = selectMode && selectedCodes.has(s.code);
    const checkHtml = selectMode ? '<div class="stock-check' + (checked ? ' checked' : '') + '"></div>' : '';

    return '<div class="stock-item' + (checked ? ' selected' : '') + '" data-code="' + esc(s.code) + '">'
      + checkHtml
      + '<div class="stock-info">'
      + '<div><span class="stock-name">' + esc(s.name) + '</span>' + aliasStr + '</div>'
      + (priceParts ? '<div class="stock-prices">' + priceParts + '</div>' : '')
      + (sharesHtml || profitHtml ? '<div style="display:flex;justify-content:space-between;align-items:center">' + sharesHtml + profitHtml + '</div>' : '')
      + '</div>'
      + '<div class="stock-actions">'
      + actionBtns
      + '</div></div>';
  }).join('');

  container.innerHTML = breadthHtml + indexHtml + stockHtml;

  // 当日盈亏 & 总盈亏 & 总市值
  if (hasAnyPosition) {
    dailyProfitBar.style.display = 'flex';
    const dCls = totalDailyProfit >= 0 ? 'up' : 'down';
    const dSign = totalDailyProfit >= 0 ? '+' : '-';
    $('dailyProfitValue').className = 'total-value ' + dCls;
    $('dailyProfitValue').textContent = dSign + Math.abs(totalDailyProfit).toFixed(2);
    totalBar.style.display = 'flex';
    const tCls = totalProfit >= 0 ? 'up' : 'down';
    const tSign = totalProfit >= 0 ? '+' : '-';
    $('totalValue').className = 'total-value ' + tCls;
    $('totalValue').textContent = tSign + Math.abs(totalProfit).toFixed(2);
    totalAmountBar.style.display = 'flex';
    $('totalAmountValue').textContent = totalAmount.toFixed(2);
  } else {
    dailyProfitBar.style.display = 'none';
    totalBar.style.display = 'none';
    totalAmountBar.style.display = 'none';
  }

  // 绑定事件
  container.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      const s = list.find(x => x.code === code);
      if (s) showForm(s, activeTab);
    });
  });
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      const s = list.find(x => x.code === code);
      if (s) {
        vscode.postMessage({ type: 'deleteStock', code, fromTab: activeTab });
      }
    });
  });

  // 多选模式：点击整行切换选中（指数行无 data-code，不受影响）
  if (selectMode) {
    container.querySelectorAll('.stock-item[data-code]').forEach(item => {
      item.addEventListener('click', () => {
        toggleSelect(item.dataset.code);
      });
    });
  }

  // 走势图按钮（带上当前周期，默认分时）
  container.querySelectorAll('.kline-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      if (code) {
        vscode.postMessage({ type: 'showKline', code, days: klineDays });
      }
    });
  });

  // 预购按钮事件（仅在自选股 tab 渲染了预购按钮）
  container.querySelectorAll('.wish-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      const s = list.find(x => x.code === code);
      if (code && s) {
        vscode.postMessage({ type: 'addWishlist', code, name: s.name });
      }
    });
  });
}

// ── 搜索结果渲染 ──
function renderSearchResults(results) {
  const container = $('searchResults');
  if (!results || results.length === 0) {
    container.classList.remove('active');
    container.innerHTML = '';
    return;
  }
  container.classList.add('active');
  container.innerHTML = results.map(r =>
    '<div class="search-item" data-code="' + esc(r.code) + '" data-name="' + esc(r.name) + '">'
    + '<span class="si-name">' + esc(r.name) + '</span>'
    + '<span class="si-code">' + esc(r.code) + '</span>'
    + '</div>'
  ).join('');
  container.querySelectorAll('.search-item').forEach(item => {
    item.addEventListener('click', () => {
      selectedResult = { code: item.dataset.code, name: item.dataset.name };
      $('codeInput').value = selectedResult.name + '（' + selectedResult.code + '）';
      container.classList.remove('active');
    });
  });
}

// ── 显示添加/编辑表单 ──
function showForm(stock, tab) {
  formTab = tab || activeTab;
  editCode = stock ? stock.code : null;
  $('formTitle').textContent = stock ? '编辑股票：' + stock.name : (formTab === 'portfolio' ? '添加持有股' : '添加股票');
  $('codeField').style.display = stock ? 'none' : 'block';
  $('codeInput').value = '';
  $('aliasInput').value = stock ? (stock.alias || '') : '';
  $('priceInput').value = stock?.purchasePrice ?? '';
  $('sharesInput').value = stock?.shares ?? '';
  $('buyDateInput').value = stock?.buyDate || localDateStr(new Date());
  $('formError').style.display = 'none';
  $('searchResults').classList.remove('active');
  selectedResult = null;

  // 新增时隐藏别名和持仓相关字段，编辑模式始终显示全部
  const isAdd = !stock;
  const isWatchlistAdd = isAdd && (formTab === 'watchlist' || formTab === 'wishlist');
  // 自选股/预购股新增时不显示别名；持有股编辑/新增都不显示别名
  const hideAlias = isAdd || formTab === 'portfolio';
  $('aliasField').style.display = hideAlias ? 'none' : '';
  $('priceField').style.display = isWatchlistAdd ? 'none' : '';
  $('sharesField').style.display = isWatchlistAdd ? 'none' : '';
  $('buyDateField').style.display = isWatchlistAdd ? 'none' : '';

  $('listView').style.display = 'none';
  $('formView').classList.add('active');
  if (!stock) $('codeInput').focus();
}

function showList() {
  $('formView').classList.remove('active');
  $('listView').style.display = '';
  editCode = null;
  selectedResult = null;
}

// ── 事件绑定 ──
$('addBtn').addEventListener('click', () => showForm(null, activeTab));
$('cancelBtn').addEventListener('click', showList);

$('codeInput').addEventListener('input', e => {
  selectedResult = null;
  const val = e.target.value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (val.length === 0) {
    $('searchResults').classList.remove('active');
    return;
  }
  searchTimer = setTimeout(() => {
    vscode.postMessage({ type: 'search', keyword: val });
  }, 300);
});

$('planMemoInput').addEventListener('input', e => {
  planMemoText = e.target.value;
  planMemoDirty = true;
  $('planMemoSaveBtn').textContent = '保存';
});

$('planMemoSaveBtn').addEventListener('click', () => {
  planMemoText = $('planMemoInput').value;
  planMemoDirty = false;
  planMemoSaving = true;
  $('planMemoSaveBtn').textContent = '已保存';
  vscode.postMessage({ type: 'savePlanMemo', text: planMemoText });
  setTimeout(() => {
    planMemoSaving = false;
    $('planMemoSaveBtn').textContent = '保存';
  }, 1200);
});

// 点击外部关闭搜索结果
document.addEventListener('click', e => {
  if (!e.target.closest('#codeField')) {
    $('searchResults').classList.remove('active');
  }
});

$('okBtn').addEventListener('click', () => {
  console.log('[okBtn click] editCode:', editCode, 'formTab:', formTab);
  const alias = $('aliasInput').value.trim();
  const purchasePrice = parseFloat($('priceInput').value) || 0;
  const shares = parseInt($('sharesInput').value) || 0;
  const buyDate = $('buyDateInput').value || undefined;

  console.log('[okBtn click] values:', { purchasePrice, shares });

  if (shares > 0 && shares % 100 !== 0) {
    console.log('[okBtn click] blocked: shares not multiple of 100, shares=', shares);
    $('formError').textContent = '持仓数量须为100的倍数';
    $('formError').style.display = 'block';
    return;
  }

  $('formError').style.display = 'none';

  if (editCode) {
    const editType = formTab === 'wishlist' ? 'editWishlist' : formTab === 'portfolio' ? 'editPortfolio' : 'editStock';
    console.log('[okBtn click] sending edit:', editType, { code: editCode, purchasePrice, shares });
    vscode.postMessage({ type: editType, code: editCode, alias, purchasePrice, shares, buyDate });
  } else {
    if (!selectedResult) {
      $('formError').textContent = '请先搜索并选择一只股票';
      $('formError').style.display = 'block';
      return;
    }
    const addType = formTab === 'wishlist' ? 'addWishlist' : formTab === 'portfolio' ? 'addPortfolio' : 'addStock';
    vscode.postMessage({
      type: addType,
      code: selectedResult.code,
      name: selectedResult.name,
      alias, purchasePrice, shares, buyDate,
    });
  }
});

// ── 多选删除 ──
function getCurrentList() {
  const src = activeTab === 'portfolio' ? allPortfolioData : activeTab === 'wishlist' ? allWishlistData : allWatchlistData;
  return src || [];
}

function rerenderList() {
  if (allWatchlistData !== null) {
    renderList({ watchlist: allWatchlistData, portfolio: allPortfolioData, wishlist: allWishlistData, indices: allIndicesData, breadth: allBreadthData }, activeTab);
  }
}

function updateSelectToolbar() {
  document.body.classList.toggle('select-mode', selectMode);
  $('selectBtn').style.display = selectMode ? 'none' : 'inline';
  $('sortBtn').style.display = selectMode ? 'none' : 'inline';
  $('exportBtn').style.display = selectMode ? 'none' : 'inline';
  $('importBtn').style.display = (selectMode || activeTab === 'wishlist') ? 'none' : 'inline';
  $('addBtn').style.display = selectMode ? 'none' : 'inline';
  $('selectAllBtn').style.display = selectMode ? 'inline' : 'none';
  $('delSelBtn').style.display = selectMode ? 'inline' : 'none';
  $('cancelSelBtn').style.display = selectMode ? 'inline' : 'none';
  $('filterBtn').style.display = (!selectMode && activeTab === 'wishlist') ? 'inline' : 'none';
  if (selectMode) {
    const list = getCurrentList();
    const allSelected = list.length > 0 && list.every(s => selectedCodes.has(s.code));
    $('selectAllBtn').textContent = allSelected ? '取消全选' : '全选';
    $('delSelBtn').textContent = '删除(' + selectedCodes.size + ')';
    $('delSelBtn').style.opacity = selectedCodes.size > 0 ? '' : '.5';
  }
}

function toggleSelect(code) {
  if (selectedCodes.has(code)) { selectedCodes.delete(code); } else { selectedCodes.add(code); }
  // 直接更新 DOM，避免整表重绘闪烁
  const item = $('stockList').querySelector('.stock-item[data-code="' + code + '"]');
  if (item) {
    const on = selectedCodes.has(code);
    item.classList.toggle('selected', on);
    const chk = item.querySelector('.stock-check');
    if (chk) { chk.classList.toggle('checked', on); }
  }
  updateSelectToolbar();
}

function exitSelectMode() {
  selectMode = false;
  selectedCodes.clear();
  updateSelectToolbar();
  rerenderList();
}

$('selectBtn').addEventListener('click', () => {
  selectMode = true;
  selectedCodes.clear();
  updateSelectToolbar();
  rerenderList();
});

$('cancelSelBtn').addEventListener('click', exitSelectMode);

$('selectAllBtn').addEventListener('click', () => {
  const list = getCurrentList();
  const allSelected = list.length > 0 && list.every(s => selectedCodes.has(s.code));
  selectedCodes = allSelected ? new Set() : new Set(list.map(s => s.code));
  rerenderList();
  updateSelectToolbar();
});

$('delSelBtn').addEventListener('click', () => {
  if (selectedCodes.size === 0) { return; }
  const codes = Array.from(selectedCodes);
  exitSelectMode();
  vscode.postMessage({ type: 'deleteStocks', codes, fromTab: activeTab });
});

// ── Tab 切换 ──
function switchTab(tab) {
  activeTab = tab;
  // 切换 Tab 时退出多选模式（选中集合按 Tab 隔离）
  selectMode = false;
  selectedCodes.clear();
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  $('importBtn').style.display = tab === 'wishlist' ? 'none' : 'inline';
  $('exportBtn').style.display = 'inline';
  $('sortBtn').style.display = 'inline';
  $('addBtn').style.display = 'inline';
  $('toolbarTitle').textContent = tab === 'watchlist' ? '自选股' : tab === 'portfolio' ? '持有股' : '预购股';
  updateSelectToolbar();
  if (allWatchlistData !== null) {
    renderList({ watchlist: allWatchlistData, portfolio: allPortfolioData, wishlist: allWishlistData, indices: allIndicesData }, tab);
  }
  // 持久化 Tab 选择
  vscode.postMessage({ type: 'saveActiveTab', activeTab: tab });
}
$('tabWatchlist').addEventListener('click', () => switchTab('watchlist'));
$('tabPortfolio').addEventListener('click', () => switchTab('portfolio'));
$('tabWishlist').addEventListener('click', () => switchTab('wishlist'));

// ── 涨跌幅排序 ──
$('sortBtn').addEventListener('click', () => {
  sortOrder = sortOrder === 'desc' ? 'asc' : sortOrder === 'asc' ? null : 'desc';
  $('sortBtn').classList.toggle('sort-active', sortOrder !== null);
  $('sortBtn').textContent = sortOrder === 'desc' ? '⬇️' : sortOrder === 'asc' ? '⬆️' : '↕️';
  if (allWatchlistData !== null) {
    renderList({ watchlist: allWatchlistData, portfolio: allPortfolioData, wishlist: allWishlistData, indices: allIndicesData, breadth: allBreadthData }, activeTab);
  }
  // 持久化排序选择
  vscode.postMessage({ type: 'saveSortOrder', sortOrder });
});

// ── 导入弹窗 ──
function showImport() {
  if (activeTab === 'portfolio') {
    showImportPortfolio();
    return;
  }
  $('importInput').value = '';
  $('importError').style.display = 'none';
  $('importResult').style.display = 'none';
  $('importProgress').style.display = 'none';
  $('importOkBtn').disabled = false;
  $('importOkBtn').textContent = '导入';
  $('listView').style.display = 'none';
  $('importView').classList.add('active');
  $('importInput').focus();
}

function hideImport() {
  $('importView').classList.remove('active');
  $('listView').style.display = '';
}

// ── 持有股导入弹窗 ──
function showImportPortfolio() {
  $('importPortfolioInput').value = '';
  $('importPortfolioError').style.display = 'none';
  $('importPortfolioResult').style.display = 'none';
  $('importPortfolioOkBtn').disabled = false;
  $('importPortfolioOkBtn').textContent = '导入';
  $('listView').style.display = 'none';
  $('importPortfolioView').classList.add('active');
  $('importPortfolioInput').focus();
}

function hideImportPortfolio() {
  $('importPortfolioView').classList.remove('active');
  $('listView').style.display = '';
}

function showImportResult(msg) {
  // 判断是自选股还是持有股的结果
  const isPortfolio = $('importPortfolioView').classList.contains('active');
  if (isPortfolio) {
    $('importPortfolioOkBtn').disabled = false;
    $('importPortfolioOkBtn').textContent = '导入';
  } else {
    $('importProgress').style.display = 'none';
    $('importOkBtn').disabled = false;
    $('importOkBtn').textContent = '导入';
  }
  const r = msg.result;
  let html = '<span class="ir-ok">成功添加: ' + r.added + ' 只</span>';
  if (r.skipped > 0) html += '<br><span class="ir-skip">已存在跳过: ' + r.skipped + ' 只</span>';
  if (r.failed > 0) {
    html += '<br><span class="ir-fail">失败: ' + r.failed + ' 只</span>';
    if (r.errors.length > 0) {
      html += '<div style="margin-top:4px;opacity:.8">' + r.errors.map(esc).join('<br>') + '</div>';
    }
  }
  if (isPortfolio) {
    $('importPortfolioResult').innerHTML = html;
    $('importPortfolioResult').style.display = 'block';
  } else {
    $('importResult').innerHTML = html;
    $('importResult').style.display = 'block';
  }
}

$('importBtn').addEventListener('click', showImport);
$('importCancelBtn').addEventListener('click', hideImport);
$('importPortfolioCancelBtn').addEventListener('click', hideImportPortfolio);

$('importOkBtn').addEventListener('click', () => {
  const text = $('importInput').value.trim();
  if (!text) {
    $('importError').textContent = '请输入股票代码或名称';
    $('importError').style.display = 'block';
    return;
  }
  $('importError').style.display = 'none';
  $('importResult').style.display = 'none';
  $('importProgress').style.display = 'block';
  $('importOkBtn').disabled = true;
  $('importOkBtn').textContent = '导入中...';
  const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
  vscode.postMessage({ type: 'importStocks', lines });
});

$('importPortfolioOkBtn').addEventListener('click', () => {
  const text = $('importPortfolioInput').value.trim();
  if (!text) {
    $('importPortfolioError').textContent = '请粘贴持有股 JSON 数据';
    $('importPortfolioError').style.display = 'block';
    return;
  }
  $('importPortfolioError').style.display = 'none';
  $('importPortfolioResult').style.display = 'none';
  $('importPortfolioOkBtn').disabled = true;
  $('importPortfolioOkBtn').textContent = '导入中...';
  vscode.postMessage({ type: 'importPortfolio', json: text });
});

// ── 导出 ──
$('exportBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'exportStocks' });
});

// ── 回调股筛选（预购股 Tab） ──
$('filterBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'filterWishlist' });
});

// ── 走势图 ──
function showKline() {
  $('klineChart').innerHTML = '';
  $('klineInfo').textContent = '';
  $('klineLoading').style.display = 'block';
  $('listView').style.display = 'none';
  $('klineView').classList.add('active');
  // 更新周期按钮状态
  document.querySelectorAll('.kline-period').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.days) === klineDays);
  });
}

function hideKline() {
  $('klineView').classList.remove('active');
  $('listView').style.display = '';
}

$('klineCloseBtn').addEventListener('click', hideKline);

// ── 走势周期切换 ──
document.querySelectorAll('.kline-period').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = Number(btn.dataset.days);
    if (btn.dataset.days === undefined || klineDays === days) { return; }
    klineDays = days;
    document.querySelectorAll('.kline-period').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    if (klineCode) {
      $('klineChart').innerHTML = '';
      $('klineInfo').textContent = '';
      $('klineLoading').style.display = 'block';
      vscode.postMessage({ type: 'showKline', code: klineCode, days });
    }
  });
});

// 成交量格式化（新浪接口单位为股，展示转为手）
function fmtVol(v) {
  const hands = v / 100;
  if (hands >= 1e8) { return (hands / 1e8).toFixed(2) + '亿手'; }
  if (hands >= 1e4) { return (hands / 1e4).toFixed(1) + '万手'; }
  return Math.round(hands) + '手';
}

// ── 分时图 ──
const MINUTE_AVG_COLOR = '#D7BA7D';

function renderMinuteChart(data, name, code, baseline) {
  $('klineLoading').style.display = 'none';
  $('klineTitle').textContent = name + '（' + code + '） 分时走势';

  if (!data || data.length === 0) {
    $('klineChart').innerHTML = '<div class="empty">暂无分时数据</div>';
    $('klineInfo').textContent = '';
    return;
  }

  const n = data.length;
  const closes = data.map(d => d.close);
  // 均价线：累计成交额 / 累成交量（5分钟粒度的近似 VWAP）
  let cumPV = 0, cumV = 0;
  const avgs = data.map(d => {
    cumPV += d.close * d.volume;
    cumV += d.volume;
    return cumV > 0 ? cumPV / cumV : d.close;
  });

  // 以昨收为中枢的对称区间，上下涨跌幅均等
  const base = baseline > 0 ? baseline : data[0].open;
  const hi = Math.max(...closes, ...avgs);
  const lo = Math.min(...closes, ...avgs);
  const maxDev = Math.max(hi - base, base - lo, base * 0.002) * 1.12;
  const yMin = base - maxDev, yMax = base + maxDev, yRange = yMax - yMin;

  const W = 280, H = 200;
  const padL = 44, padR = 34, padT = 14, padB = 20;
  const chartW = W - padL - padR;
  const priceH = 114, volGap = 8, volH = 44;
  const priceTop = padT, priceBottom = priceTop + priceH;
  const volTop = priceBottom + volGap, volBottom = volTop + volH;

  const toX = i => padL + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW);
  const toY = v => priceTop + (priceH - ((v - yMin) / yRange) * priceH);
  const step = Math.max(1, Math.ceil(n / 6));

  const last = closes[n - 1];
  const isUp = last >= base;
  const lineColor = isUp ? '#F14C4C' : '#73C991';

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

  // Y 轴网格：左侧价格刻度，右侧涨跌幅刻度
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const yVal = yMin + (yRange / ySteps) * i;
    const yPos = toY(yVal);
    const pct = base > 0 ? (yVal - base) / base * 100 : 0;
    svg += '<line x1="' + padL + '" y1="' + yPos + '" x2="' + (W - padR) + '" y2="' + yPos + '" stroke="var(--vscode-widget-border)" stroke-width="0.5" stroke-dasharray="2,2"/>';
    svg += '<text x="' + (padL - 4) + '" y="' + (yPos + 3) + '" text-anchor="end" class="kline-price">' + yVal.toFixed(2) + '</text>';
    svg += '<text x="' + (W - padR + 4) + '" y="' + (yPos + 3) + '" text-anchor="start" class="kline-price">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</text>';
  }

  // 昨收基准线（中线）
  svg += '<line x1="' + padL + '" y1="' + toY(base) + '" x2="' + (W - padR) + '" y2="' + toY(base) + '" stroke="var(--vscode-widget-border)" stroke-width="1"/>';

  // 价格折线 + 均价线（分时点位密，不画数据点圆圈）
  if (n > 1) {
    svg += '<polyline points="' + closes.map((v, i) => toX(i) + ',' + toY(v)).join(' ') + '" class="kline-line" stroke="' + lineColor + '"/>';
    svg += '<polyline points="' + avgs.map((v, i) => toX(i) + ',' + toY(v)).join(' ') + '" class="kline-line" stroke="' + MINUTE_AVG_COLOR + '"/>';
  }

  // 成交量柱：红涨绿跌（与前一根收盘比较，首根与开盘比较）
  const maxV = Math.max(...data.map(d => d.volume), 1);
  const slotW = chartW / n;
  const barW = Math.max(2, Math.floor(slotW * 0.66));
  data.forEach((d, i) => {
    const prevClose = i > 0 ? data[i - 1].close : d.open;
    const barColor = d.close >= prevClose ? '#F14C4C' : '#73C991';
    const h = Math.max(1, Math.round(d.volume / maxV * volH));
    svg += '<rect x="' + (toX(i) - barW / 2) + '" y="' + (volBottom - h) + '" width="' + barW + '" height="' + h + '" fill="' + barColor + '" opacity=".78"/>';
  });
  svg += '<line x1="' + padL + '" y1="' + volTop + '" x2="' + (W - padR) + '" y2="' + volTop + '" stroke="var(--vscode-widget-border)" stroke-width="0.5"/>';
  svg += '<text x="' + (padL - 4) + '" y="' + (volTop + 3) + '" text-anchor="end" class="kline-price">' + fmtVol(maxV) + '</text>';
  svg += '<text x="' + (padL - 4) + '" y="' + (volBottom + 3) + '" text-anchor="end" class="kline-price">0</text>';

  // 时间轴标签
  data.forEach((d, i) => {
    if (i % step === 0 || i === n - 1) {
      const t = d.date.length > 10 ? d.date.slice(11, 16) : d.date.slice(5);
      svg += '<text x="' + toX(i) + '" y="' + (H - 6) + '" text-anchor="middle" class="kline-date">' + esc(t) + '</text>';
    }
  });

  // hover 十字线
  svg += '<line id="klineCross" x1="0" y1="' + priceTop + '" x2="0" y2="' + volBottom + '" stroke="var(--vscode-focusBorder)" stroke-width="1" stroke-dasharray="3,3" style="display:none"/>';
  svg += '</svg>';

  const chart = $('klineChart');
  chart.innerHTML = '<div class="kline-legend"><span><span class="kl-sw" style="background:' + lineColor + '"></span>价格</span><span><span class="kl-sw" style="background:' + MINUTE_AVG_COLOR + '"></span>均价</span></div>'
    + svg + '<div class="kline-tip" id="klineTip"></div>';

  // hover：十字线 + 当时点明细 tooltip
  const svgEl = chart.querySelector('svg');
  const cross = svgEl.querySelector('#klineCross');
  const tip = $('klineTip');
  svgEl.addEventListener('mousemove', e => {
    const rect = svgEl.getBoundingClientRect();
    const vx = (e.clientX - rect.left) / rect.width * W;
    let i = n === 1 ? 0 : Math.round((vx - padL) / chartW * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const x = toX(i);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
    const d = data[i];
    const chg = d.close - base;
    const chgPct = base > 0 ? chg / base * 100 : 0;
    const tCls = chg >= 0 ? 'up' : 'down';
    const tSign = chg >= 0 ? '+' : '';
    const time = d.date.length > 10 ? d.date.slice(11, 16) : d.date.slice(5);
    tip.innerHTML = '<div class="kt-date">' + esc(time) + '</div>'
      + '<div>价 <span class="' + tCls + '">' + d.close.toFixed(2) + '</span>　' + tSign + chg.toFixed(2) + '（' + tSign + chgPct.toFixed(2) + '%）</div>'
      + '<div>均价 ' + avgs[i].toFixed(2) + '</div>'
      + '<div>量 ' + fmtVol(d.volume) + '</div>';
    tip.style.display = 'block';
    const chartRect = chart.getBoundingClientRect();
    let tx = e.clientX - chartRect.left + 14;
    const ty = e.clientY - chartRect.top - 8;
    if (tx + tip.offsetWidth > chartRect.width) {
      tx = Math.max(0, e.clientX - chartRect.left - tip.offsetWidth - 14);
    }
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  });
  svgEl.addEventListener('mouseleave', () => {
    cross.style.display = 'none';
    tip.style.display = 'none';
  });

  // 底部信息：最新/涨跌/均价/最高最低/总量
  const chg = last - base;
  const chgPct = base > 0 ? chg / base * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  const totalV = data.reduce((a, d) => a + d.volume, 0);
  $('klineInfo').innerHTML = '最新 <span class="' + cls + '">' + last.toFixed(2) + '</span>　<span class="' + cls + '">' + sign + chg.toFixed(2) + '（' + sign + chgPct.toFixed(2) + '%）</span>　均价 ' + avgs[n - 1].toFixed(2)
    + '　最高 ' + Math.max(...data.map(d => d.high)).toFixed(2) + '　最低 ' + Math.min(...data.map(d => d.low)).toFixed(2)
    + '　总量 ' + fmtVol(totalV);
}

function renderKlineChart(data, name, code, days) {
  $('klineLoading').style.display = 'none';
  $('klineTitle').textContent = name + '（' + code + '） 近' + days + '日走势';

  if (!data || data.length === 0) {
    $('klineChart').innerHTML = '<div class="empty">暂无走势数据</div>';
    return;
  }

  const closes = data.map(d => d.close);
  const dates = data.map(d => d.date.slice(5)); // MM-DD
  const minP = Math.min(...closes);
  const maxP = Math.max(...closes);
  const range = maxP - minP || 1;
  const pad = range * 0.15;
  const yMin = minP - pad;
  const yMax = maxP + pad;
  const yRange = yMax - yMin;

  const n = data.length;
  const W = 280, H = 200;
  const padL = 50, padR = 24, padT = 14, padB = 20;
  const chartW = W - padL - padR;
  // 上面板：价格折线；下面板：成交量柱。两面板共享 x 轴，各自独立 y 刻度（非双轴）
  const priceH = 114, volGap = 8, volH = 44;
  const priceTop = padT, priceBottom = priceTop + priceH;
  const volTop = priceBottom + volGap, volBottom = volTop + volH;

  const toX = i => padL + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW);
  const toY = v => priceTop + (priceH - ((v - yMin) / yRange) * priceH);
  // 标签抽样步长：点位多时抽稀收盘价/日期标注，避免文字重叠
  const step = Math.max(1, Math.ceil(n / 10));

  const isUp = closes[n - 1] >= closes[0];
  const lineColor = isUp ? '#F14C4C' : '#73C991';

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

  // 价格面板 Y 轴参考线
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const yVal = yMin + (yRange / ySteps) * i;
    const yPos = toY(yVal);
    svg += '<line x1="' + padL + '" y1="' + yPos + '" x2="' + (W - padR) + '" y2="' + yPos + '" stroke="var(--vscode-widget-border)" stroke-width="0.5" stroke-dasharray="2,2"/>';
    svg += '<text x="' + (padL - 4) + '" y="' + (yPos + 3) + '" text-anchor="end" class="kline-price">' + yVal.toFixed(2) + '</text>';
  }

  // 折线
  if (n > 1) {
    const points = closes.map((v, i) => toX(i) + ',' + toY(v)).join(' ');
    svg += '<polyline points="' + points + '" class="kline-line" stroke="' + lineColor + '"/>';
  }

  // 成交量面板：柱色红涨绿跌（与前一日收盘比较，首日与开盘比较）
  const maxV = Math.max(...data.map(d => d.volume), 1);
  const slotW = chartW / n;
  const barW = Math.max(2, Math.floor(slotW * 0.66));
  data.forEach((d, i) => {
    const prevClose = i > 0 ? data[i - 1].close : d.open;
    const barColor = d.close >= prevClose ? '#F14C4C' : '#73C991';
    const h = Math.max(1, Math.round(d.volume / maxV * volH));
    svg += '<rect x="' + (toX(i) - barW / 2) + '" y="' + (volBottom - h) + '" width="' + barW + '" height="' + h + '" fill="' + barColor + '" opacity=".78"/>';
  });
  // 面板边界线 + 峰值刻度
  svg += '<line x1="' + padL + '" y1="' + volTop + '" x2="' + (W - padR) + '" y2="' + volTop + '" stroke="var(--vscode-widget-border)" stroke-width="0.5"/>';
  svg += '<text x="' + (padL - 4) + '" y="' + (volTop + 3) + '" text-anchor="end" class="kline-price">' + fmtVol(maxV) + '</text>';
  svg += '<text x="' + (padL - 4) + '" y="' + (volBottom + 3) + '" text-anchor="end" class="kline-price">0</text>';

  // 数据点 + 抽稀后的收盘价/日期标注
  data.forEach((d, i) => {
    const cx = toX(i), cy = toY(d.close);
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="3" class="kline-dot" stroke="' + lineColor + '"/>';
    if (i % step === 0) {
      svg += '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" class="kline-price">' + d.close.toFixed(2) + '</text>';
      svg += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle" class="kline-date">' + esc(dates[i]) + '</text>';
    }
  });

  // hover 十字线
  svg += '<line id="klineCross" x1="0" y1="' + priceTop + '" x2="0" y2="' + volBottom + '" stroke="var(--vscode-focusBorder)" stroke-width="1" stroke-dasharray="3,3" style="display:none"/>';
  svg += '</svg>';

  const chart = $('klineChart');
  chart.innerHTML = svg + '<div class="kline-tip" id="klineTip"></div>';

  // hover：十字线 + 当日明细 tooltip
  const svgEl = chart.querySelector('svg');
  const cross = svgEl.querySelector('#klineCross');
  const tip = $('klineTip');
  svgEl.addEventListener('mousemove', e => {
    const rect = svgEl.getBoundingClientRect();
    const vx = (e.clientX - rect.left) / rect.width * W;
    let i = n === 1 ? 0 : Math.round((vx - padL) / chartW * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const x = toX(i);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.style.display = '';
    const d = data[i];
    const prevClose = i > 0 ? data[i - 1].close : d.open;
    const chg = d.close - prevClose;
    const chgPct = prevClose !== 0 ? chg / prevClose * 100 : 0;
    const tCls = chg >= 0 ? 'up' : 'down';
    const tSign = chg >= 0 ? '+' : '';
    tip.innerHTML = '<div class="kt-date">' + esc(d.date) + '</div>'
      + '<div>开 ' + d.open.toFixed(2) + '　高 ' + d.high.toFixed(2) + '</div>'
      + '<div>收 <span class="' + tCls + '">' + d.close.toFixed(2) + '</span>　低 ' + d.low.toFixed(2) + '</div>'
      + '<div>量 ' + fmtVol(d.volume) + '　<span class="' + tCls + '">' + tSign + chg.toFixed(2) + '（' + tSign + chgPct.toFixed(2) + '%）</span></div>';
    tip.style.display = 'block';
    const chartRect = chart.getBoundingClientRect();
    let tx = e.clientX - chartRect.left + 14;
    const ty = e.clientY - chartRect.top - 8;
    if (tx + tip.offsetWidth > chartRect.width) {
      tx = Math.max(0, e.clientX - chartRect.left - tip.offsetWidth - 14);
    }
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  });
  svgEl.addEventListener('mouseleave', () => {
    cross.style.display = 'none';
    tip.style.display = 'none';
  });

  // 涨跌信息 + 成交量统计
  const chg = closes[n - 1] - closes[0];
  const chgPct = closes[0] !== 0 ? (chg / closes[0] * 100) : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  const totalV = data.reduce((a, d) => a + d.volume, 0);
  $('klineInfo').innerHTML = '<span class="' + cls + '">' + sign + chg.toFixed(2) + '（' + sign + chgPct.toFixed(2) + '%）</span>　期间最高 ' + Math.max(...data.map(d => d.high)).toFixed(2) + '　最低 ' + Math.min(...data.map(d => d.low)).toFixed(2) + '　总量 ' + fmtVol(totalV) + '　日均 ' + fmtVol(totalV / n);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// 本地日期 YYYY-MM-DD（避免 toISOString 的 UTC 偏移）
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
