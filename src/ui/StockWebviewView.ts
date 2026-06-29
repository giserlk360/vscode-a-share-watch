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

  private _view?: vscode.WebviewView;
  private liveDataMap: Map<string, StockData> = new Map();

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
        case 'savePlanMemo':
          await this._handleSavePlanMemo(msg.text);
          break;
        case 'importStocks':
          await this._handleImport(msg.lines);
          break;
        case 'exportStocks':
          await this._handleExport();
          break;
        case 'showKline':
          await this._handleShowKline(msg.code, msg.days || 5);
          break;
        case 'saveSortOrder':
          this._handleSaveSortOrder(msg.sortOrder);
          break;
        case 'saveActiveTab':
          this._handleSaveActiveTab(msg.activeTab);
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
    const settings = this.priceMonitor.getSettings();

    const mapEntry = (e: StockEntry) => {
      const live = this.liveDataMap.get(e.code);
      return {
        code: e.code,
        name: e.name,
        alias: e.alias ?? '',
        purchasePrice: e.purchasePrice,
        shares: e.shares,
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

    this._view.webview.postMessage({ type: 'stockList', watchlist, portfolio, wishlist, indices, planMemo: this.stockManager.getPlanMemo() });
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
        carouselEnabled: true,
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
        carouselEnabled: true,
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
        carouselEnabled: true,
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
      carouselEnabled: true,
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

  private async _handleShowKline(code: string, days: number = 5): Promise<void> {
    console.log('[StockWebview] showKline received:', code, 'days:', days);
    if (!this._view) { return; }
    try {
      const kline = await this.dataProvider.fetchKline(code, days);
      console.log('[StockWebview] kline data:', JSON.stringify(kline));
      const live = this.liveDataMap.get(code);
      const name = live?.name || this.stockManager.getByCode(code)?.name || code;
      this._view.webview.postMessage({ type: 'klineData', data: kline, name, code, days });
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
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;overflow:hidden;height:100vh}
#listView{display:flex;flex-direction:column;height:100vh}
.toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--vscode-widget-border)}
.toolbar-title{font-size:11px;font-weight:600;opacity:.7}
.toolbar-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:3px;opacity:.7}
.toolbar-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.stock-list{padding:0;flex:1;overflow-y:auto;min-height:0}
.stock-item{display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid var(--vscode-widget-border);cursor:default}
.stock-index{background:var(--vscode-editor-background);opacity:.85}
.stock-item:hover{background:var(--vscode-list-hoverBackground)}
.stock-info{flex:1;min-width:0}
.stock-name{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stock-alias{font-size:10px;color:var(--vscode-descriptionForeground);margin-left:4px}
.stock-code{font-size:10px;color:var(--vscode-descriptionForeground)}
.stock-prices{display:flex;align-items:baseline;gap:6px;margin-top:2px}
.stock-current{font-size:11px;font-weight:500}
.stock-change{font-size:11px;font-weight:500}
.stock-purchase{font-size:10px;color:var(--vscode-descriptionForeground)}
.stock-shares{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}
.stock-profit{font-size:10px;font-weight:500;margin-top:2px}
.total-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background);font-size:11px}
.total-label{font-weight:600;opacity:.8}
.total-value{font-weight:700;font-size:12px}
.up{color:#F14C4C}
.down{color:#73C991}
.stock-actions{display:flex;gap:2px;opacity:0;transition:opacity .15s}
.stock-item:hover .stock-actions{opacity:1}
.act-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:3px;opacity:.6}
.act-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.empty{text-align:center;padding:24px 12px;color:var(--vscode-descriptionForeground);font-size:11px}
/* 添加/编辑表单 */
.form-overlay{display:none;padding:12px}
.form-overlay.active{display:block}
.form-title{font-size:13px;font-weight:600;margin-bottom:12px}
.field{margin-bottom:10px}
.field label{display:block;font-size:11px;color:var(--vscode-foreground);margin-bottom:4px}
.field input{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:5px 8px;outline:none}
.field input:focus{border-color:var(--vscode-focusBorder)}
.field input::placeholder{color:var(--vscode-input-placeholderForeground)}
.search-results{border:1px solid var(--vscode-widget-border);background:var(--vscode-dropdown-background);max-height:160px;overflow-y:auto;display:none}
.search-results.active{display:block}
.search-item{padding:5px 8px;cursor:pointer;font-size:11px;display:flex;justify-content:space-between}
.search-item:hover{background:var(--vscode-list-hoverBackground)}
.search-item .si-name{font-weight:500}
.search-item .si-code{color:var(--vscode-descriptionForeground)}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}
.form-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.btn{padding:5px 14px;font-size:11px;border:none;cursor:pointer;border-radius:2px}
.btn-cancel{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.btn:hover{opacity:.85}
.form-error{color:var(--vscode-errorForeground);font-size:11px;margin-top:6px;display:none}
/* Tab 栏 */
.tab-bar{display:flex;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background)}
.tab-btn{flex:1;padding:6px 0;font-size:11px;font-weight:500;background:none;border:none;border-bottom:2px solid transparent;color:var(--vscode-foreground);cursor:pointer;opacity:.7;transition:opacity .15s,border-color .15s}
.tab-btn:hover{opacity:1}
.tab-btn.active{opacity:1;border-bottom-color:var(--vscode-focusBorder);font-weight:600}
.toolbar-actions{display:flex;gap:4px}
.sort-active{color:var(--vscode-focusBorder)!important;opacity:1!important}
/* 导入弹窗 */
#importView textarea{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:6px 8px;outline:none;resize:vertical;font-family:var(--vscode-font-family);line-height:1.4}
#importView textarea:focus{border-color:var(--vscode-focusBorder)}
#importView textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
.import-result{font-size:11px;padding:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:3px;margin-bottom:8px;line-height:1.5}
.ir-ok{color:#73C991}
.ir-skip{color:var(--vscode-descriptionForeground)}
.ir-fail{color:var(--vscode-errorForeground)}
.import-progress{padding:4px 0;margin-bottom:4px}
/* 走势图 */
#klineChart svg{width:100%;height:140px;display:block}
.kline-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.kline-dot{stroke-width:2;fill:var(--vscode-sideBar-background)}
.kline-date{fill:var(--vscode-descriptionForeground);font-size:9px;font-family:var(--vscode-font-family)}
.kline-price{fill:var(--vscode-descriptionForeground);font-size:9px;font-family:var(--vscode-font-family)}
.kline-info{font-size:10px;color:var(--vscode-descriptionForeground);text-align:center;margin-top:6px;line-height:1.6}
.kline-period{padding:3px 10px;font-size:10px;opacity:.6;background:none;border:1px solid var(--vscode-widget-border);color:var(--vscode-foreground);cursor:pointer;border-radius:2px}
.kline-period.active{opacity:1;border-color:var(--vscode-focusBorder)}
/* 明日计划备忘录 */
.plan-memo{border-top:1px solid var(--vscode-widget-border);padding:8px 12px;background:var(--vscode-sideBar-background)}
.plan-memo-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.plan-memo-title{font-size:11px;font-weight:600;color:var(--vscode-foreground);opacity:.75}
.plan-memo-save{background:var(--vscode-button-background);border:none;color:var(--vscode-button-foreground);cursor:pointer;font-size:11px;padding:2px 10px;border-radius:2px;line-height:18px;flex:0 0 auto}
.plan-memo-save:hover{opacity:.88}
#planMemoInput{width:100%;min-height:58px;max-height:140px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:6px 8px;outline:none;resize:vertical;font-family:var(--vscode-font-family);line-height:1.4}
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
      <button class="toolbar-btn" id="sortBtn" title="按涨跌幅排序">↕</button>
      <button class="toolbar-btn" id="exportBtn" title="导出">导出</button>
      <button class="toolbar-btn" id="importBtn" title="导入">导入</button>
      <button class="toolbar-btn" id="addBtn" title="添加股票">＋</button>
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
  <div id="emptyMsg" class="empty" style="display:none">暂无股票，点击 ＋ 添加</div>
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
<div id="klineView" class="form-overlay">
  <div class="form-title" id="klineTitle">股价走势</div>
  <div style="display:flex;gap:8px;margin-bottom:8px">
    <button class="btn btn-ok kline-period active" id="kline5d">5日</button>
    <button class="btn btn-ok kline-period" id="kline10d">10日</button>
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
let klineDays = 5;             // 走势图天数（5 或 10）
let klineCode = '';            // 当前走势图股票代码
let klineName = '';            // 当前走势图股票名称
let allIndicesData = null;   // 缓存指数数据
let sortOrder = null;         // null=默认, 'desc'=涨幅优先, 'asc'=跌幅优先
let formTab = 'watchlist';    // 当前表单操作的 Tab 来源

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
    renderList(msg, activeTab);
  }
  if (msg.type === 'searchResult') renderSearchResults(msg.results);
  if (msg.type === 'addSuccess' || msg.type === 'editSuccess') { showList(); }
  if (msg.type === 'error') {
    const errDiv = $('importView').classList.contains('active') ? $('importError') : $('formError');
    errDiv.textContent = msg.text;
    errDiv.style.display = 'block';
  }
  if (msg.type === 'displayOptions') applyDisplayOptions(msg.options);
  if (msg.type === 'importResult') showImportResult(msg);
  if (msg.type === 'klineData') {
    klineCode = msg.code;
    klineName = msg.name;
    klineDays = msg.days || 5;
    showKline();
    renderKlineChart(msg.data, msg.name, msg.code, klineDays);
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
    $('sortBtn').textContent = sortOrder === 'desc' ? '↓' : sortOrder === 'asc' ? '↑' : '↕';
  }
  // 恢复 Tab 状态
  if (opts.activeTab) {
    const savedTab = ['watchlist', 'wishlist', 'portfolio'].includes(opts.activeTab) ? opts.activeTab : 'watchlist';
    activeTab = savedTab;
    switchTab(savedTab);
  }
}

// ── 渲染股票列表 ──
function renderList(msg, tab) {
  tab = tab || 'watchlist';
  let list = tab === 'portfolio' ? (msg.portfolio || []) : tab === 'wishlist' ? (msg.wishlist || []) : (msg.watchlist || []);
  const indices = msg.indices || [];

  // 按涨跌幅排序
  if (sortOrder === 'desc' || sortOrder === 'asc') {
    list = [...list].sort((a, b) => {
      const ra = a.changeRate ?? 0;
      const rb = b.changeRate ?? 0;
      return sortOrder === 'desc' ? rb - ra : ra - rb;
    });
  }
  const container = $('stockList');
  const empty = $('emptyMsg');
  const dailyProfitBar = $('dailyProfitBar');
  const totalBar = $('totalBar');
  const totalAmountBar = $('totalAmountBar');
  if ((!list || list.length === 0) && indices.length === 0) {
    container.innerHTML = '';
    empty.textContent = '暂无股票';
    empty.style.display = 'block';
    dailyProfitBar.style.display = 'none';
    totalBar.style.display = 'none';
    totalAmountBar.style.display = 'none';
    return;
  }
  empty.style.display = 'none';

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
        // 当日盈亏
        if (s.closePrice && s.closePrice > 0) {
          totalDailyProfit += (s.currentPrice - s.closePrice) * s.shares;
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

    return '<div class="stock-item" data-code="' + esc(s.code) + '">'
      + '<div class="stock-info">'
      + '<div><span class="stock-name">' + esc(s.name) + '</span>' + aliasStr + '</div>'
      + (priceParts ? '<div class="stock-prices">' + priceParts + '</div>' : '')
      + (sharesHtml || profitHtml ? '<div style="display:flex;justify-content:space-between;align-items:center">' + sharesHtml + profitHtml + '</div>' : '')
      + '</div>'
      + '<div class="stock-actions">'
      + actionBtns
      + '</div></div>';
  }).join('');

  container.innerHTML = indexHtml + stockHtml;

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

  // 走势图按钮
  container.querySelectorAll('.kline-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      if (code) {
        vscode.postMessage({ type: 'showKline', code });
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
    vscode.postMessage({ type: editType, code: editCode, alias, purchasePrice, shares });
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
      alias, purchasePrice, shares,
    });
  }
});

// ── Tab 切换 ──
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  $('importBtn').style.display = tab === 'watchlist' ? 'inline' : 'none';
  $('exportBtn').style.display = 'inline';
  $('sortBtn').style.display = 'inline';
  $('addBtn').style.display = 'inline';
  $('toolbarTitle').textContent = tab === 'watchlist' ? '自选股' : tab === 'portfolio' ? '持有股' : '预购股';
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
  $('sortBtn').textContent = sortOrder === 'desc' ? '↓' : sortOrder === 'asc' ? '↑' : '↕';
  if (allWatchlistData !== null) {
    renderList({ watchlist: allWatchlistData, portfolio: allPortfolioData, wishlist: allWishlistData, indices: allIndicesData }, activeTab);
  }
  // 持久化排序选择
  vscode.postMessage({ type: 'saveSortOrder', sortOrder });
});

// ── 导入弹窗 ──
function showImport() {
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

function showImportResult(msg) {
  $('importProgress').style.display = 'none';
  $('importOkBtn').disabled = false;
  $('importOkBtn').textContent = '导入';
  const r = msg.result;
  let html = '<span class="ir-ok">成功添加: ' + r.added + ' 只</span>';
  if (r.skipped > 0) html += '<br><span class="ir-skip">已存在跳过: ' + r.skipped + ' 只</span>';
  if (r.failed > 0) {
    html += '<br><span class="ir-fail">失败: ' + r.failed + ' 只</span>';
    if (r.errors.length > 0) {
      html += '<div style="margin-top:4px;opacity:.8">' + r.errors.map(esc).join('<br>') + '</div>';
    }
  }
  $('importResult').innerHTML = html;
  $('importResult').style.display = 'block';
}

$('importBtn').addEventListener('click', showImport);
$('importCancelBtn').addEventListener('click', hideImport);

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

// ── 导出 ──
$('exportBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'exportStocks' });
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
    btn.classList.toggle('active', (klineDays === 5 && btn.id === 'kline5d') || (klineDays === 10 && btn.id === 'kline10d'));
  });
}

function hideKline() {
  $('klineView').classList.remove('active');
  $('listView').style.display = '';
}

$('klineCloseBtn').addEventListener('click', hideKline);

// ── 走势周期切换 ──
$('kline5d').addEventListener('click', () => {
  if (klineDays === 5) return;
  klineDays = 5;
  document.querySelectorAll('.kline-period').forEach(btn => {
    btn.classList.toggle('active', btn.id === 'kline5d');
  });
  if (klineCode) {
    $('klineChart').innerHTML = '';
    $('klineInfo').textContent = '';
    $('klineLoading').style.display = 'block';
    vscode.postMessage({ type: 'showKline', code: klineCode, days: 5 });
  }
});
$('kline10d').addEventListener('click', () => {
  if (klineDays === 10) return;
  klineDays = 10;
  document.querySelectorAll('.kline-period').forEach(btn => {
    btn.classList.toggle('active', btn.id === 'kline10d');
  });
  if (klineCode) {
    $('klineChart').innerHTML = '';
    $('klineInfo').textContent = '';
    $('klineLoading').style.display = 'block';
    vscode.postMessage({ type: 'showKline', code: klineCode, days: 10 });
  }
});

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

  const W = 280, H = 140;
  const padL = 50, padR = 10, padT = 15, padB = 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const toX = i => padL + (data.length === 1 ? chartW / 2 : (i / (data.length - 1)) * chartW);
  const toY = v => padT + chartH - ((v - yMin) / yRange) * chartH;

  const isUp = closes[closes.length - 1] >= closes[0];
  const lineColor = isUp ? '#F14C4C' : '#73C991';

  // 构建 SVG
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

  // Y轴参考线
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const yVal = yMin + (yRange / ySteps) * i;
    const yPos = toY(yVal);
    svg += '<line x1="' + padL + '" y1="' + yPos + '" x2="' + (W - padR) + '" y2="' + yPos + '" stroke="var(--vscode-widget-border)" stroke-width="0.5" stroke-dasharray="2,2"/>';
    svg += '<text x="' + (padL - 4) + '" y="' + (yPos + 3) + '" text-anchor="end" class="kline-price">' + yVal.toFixed(2) + '</text>';
  }

  // 折线
  if (data.length > 1) {
    const points = closes.map((v, i) => toX(i) + ',' + toY(v)).join(' ');
    svg += '<polyline points="' + points + '" class="kline-line" stroke="' + lineColor + '"/>';
  }

  // 数据点 + 日期标签
  data.forEach((d, i) => {
    const cx = toX(i), cy = toY(d.close);
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="3" class="kline-dot" stroke="' + lineColor + '"/>';
    // 收盘价标注
    svg += '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" class="kline-price" fill="' + lineColor + '">' + d.close.toFixed(2) + '</text>';
    // 日期
    svg += '<text x="' + cx + '" y="' + (H - 4) + '" text-anchor="middle" class="kline-date">' + esc(dates[i]) + '</text>';
  });

  svg += '</svg>';
  $('klineChart').innerHTML = svg;

  // 涨跌信息
  const chg = closes[closes.length - 1] - closes[0];
  const chgPct = closes[0] !== 0 ? (chg / closes[0] * 100) : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const sign = chg >= 0 ? '+' : '';
  $('klineInfo').innerHTML = '<span class="' + cls + '">' + sign + chg.toFixed(2) + '（' + sign + chgPct.toFixed(2) + '%）</span>　期间最高 ' + Math.max(...data.map(d => d.high)).toFixed(2) + '　最低 ' + Math.min(...data.map(d => d.low)).toFixed(2);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
