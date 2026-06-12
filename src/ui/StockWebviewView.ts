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
        case 'editStock':
          await this._handleEdit(msg);
          break;
        case 'deleteStock':
          await this._handleDelete(msg.code);
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
    const entries = this.stockManager.getAll();
    const list = entries.map(e => {
      const live = this.liveDataMap.get(e.code);
      return {
        code: e.code,
        name: e.name,
        alias: e.alias ?? '',
        purchasePrice: e.purchasePrice,
        shares: e.shares,
        currentPrice: live?.currentPrice,
        changeRate: live?.changeRate,
        isETF: live?.isETF ?? false,
        alertEnabled: e.alertEnabled,
        targetPrice: e.targetPrice,
        targetChangeRate: e.targetChangeRate,
      };
    });

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

    this._view.webview.postMessage({ type: 'stockList', list, indices });
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
        alertEnabled: !!msg.alertEnabled,
        targetPrice: msg.targetPrice > 0 ? msg.targetPrice : undefined,
        targetChangeRate: msg.targetChangeRate > 0 ? msg.targetChangeRate : undefined,
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
        alertEnabled: !!msg.alertEnabled,
        targetPrice: msg.targetPrice > 0 ? msg.targetPrice : undefined,
        targetChangeRate: msg.targetChangeRate > 0 ? msg.targetChangeRate : undefined,
      });
      this._sendStockList();
      this._view?.webview.postMessage({ type: 'editSuccess' });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
  }

  private async _handleDelete(code: string): Promise<void> {
    try {
      const entries = this.stockManager.getAll();
      const entry = entries.find(e => e.code === code);
      const name = entry?.name || code;
      const answer = await vscode.window.showWarningMessage(
        `确定删除 ${name}（${code}）？`,
        { modal: true },
        '删除'
      );
      if (answer !== '删除') { return; }
      await this.stockManager.remove(code);
      this.liveDataMap.delete(code);
      this._sendStockList();
    } catch (err) {
      this._view?.webview.postMessage({ type: 'error', text: (err as Error).message });
    }
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
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;overflow-x:hidden}
.toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--vscode-widget-border)}
.toolbar-title{font-size:11px;font-weight:600;opacity:.7}
.toolbar-btn{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:3px;opacity:.7}
.toolbar-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.stock-list{padding:0}
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
/* 预警配置 */
.alert-section{border-top:1px solid var(--vscode-widget-border);margin-top:10px;padding-top:10px}
.alert-check{display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin-bottom:8px}
.alert-check input{cursor:pointer}
.alert-fields{display:none;padding-left:4px}
.alert-fields.active{display:block}
</style>
</head>
<body>
<div id="listView">
  <div class="toolbar">
    <span class="toolbar-title">股票列表</span>
    <button class="toolbar-btn" id="addBtn" title="添加股票">＋</button>
  </div>
  <div id="stockList" class="stock-list"></div>
  <div id="totalBar" class="total-bar" style="display:none">
    <span class="total-label">总盈亏</span>
    <span id="totalValue" class="total-value"></span>
  </div>
  <div id="totalAmountBar" class="total-bar" style="display:none">
    <span class="total-label">总市值</span>
    <span id="totalAmountValue" class="total-value"></span>
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
  <div class="field">
    <label>别名（可选）</label>
    <input id="aliasInput" placeholder="自定义别名...">
  </div>
  <div class="field">
    <label>买入价格（可选）</label>
    <input id="priceInput" type="number" min="0" step="0.01" placeholder="买入价格">
  </div>
  <div class="field">
    <label>持仓数量（可选，须为100的倍数）</label>
    <input id="sharesInput" type="number" min="0" step="100" placeholder="如: 100, 200...">
    <div class="hint">A股最小交易单位为100股（1手）</div>
  </div>
  <div class="alert-section">
    <label class="alert-check"><input type="checkbox" id="alertEnabledCheck"> 启用价格预警</label>
    <div class="alert-fields" id="alertFields">
      <div class="field">
        <label>目标价格（可选）</label>
        <input id="targetPriceInput" type="number" min="0" step="0.01" placeholder="当前价 ≥ 目标价时触发">
      </div>
      <div class="field">
        <label>目标涨跌幅 %（可选）</label>
        <input id="targetChangeRateInput" type="number" min="0" step="0.1" placeholder="如 5 表示涨跌幅达5%时触发">
        <div class="hint">涨跌幅绝对值达到设定值时触发</div>
      </div>
    </div>
  </div>
  <div class="form-error" id="formError"></div>
  <div class="form-btns">
    <button class="btn btn-cancel" id="cancelBtn">取消</button>
    <button class="btn btn-ok" id="okBtn">确定</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

let editCode = null; // 非 null 时为编辑模式
let selectedResult = null; // 搜索选中的结果 {code, name}
let searchTimer = null;
let displayOpts = { showCode:true, showCurrentPrice:true, showChangeRate:true, showPurchasePrice:true, showShares:true, showProfit:true, showPositionChangeRate:false, showPositionAmount:false };

// ── 消息处理 ──
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'stockList') renderList(msg);
  if (msg.type === 'searchResult') renderSearchResults(msg.results);
  if (msg.type === 'addSuccess' || msg.type === 'editSuccess') showList();
  if (msg.type === 'error') { $('formError').textContent = msg.text; $('formError').style.display = 'block'; }
  if (msg.type === 'displayOptions') applyDisplayOptions(msg.options);
});

// ── 显示设置（由插件设置面板控制） ──
function applyDisplayOptions(opts) {
  if (!opts) return;
  displayOpts = { ...displayOpts, ...opts };
}

// ── 渲染股票列表 ──
function renderList(msg) {
  const list = msg.list;
  const indices = msg.indices || [];
  const container = $('stockList');
  const empty = $('emptyMsg');
  const totalBar = $('totalBar');
  const totalAmountBar = $('totalAmountBar');
  if ((!list || list.length === 0) && indices.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
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

    return '<div class="stock-item" data-code="' + esc(s.code) + '">'
      + '<div class="stock-info">'
      + '<div><span class="stock-name">' + esc(s.name) + '</span>' + aliasStr + '</div>'
      + (priceParts ? '<div class="stock-prices">' + priceParts + '</div>' : '')
      + (sharesHtml || profitHtml ? '<div style="display:flex;justify-content:space-between;align-items:center">' + sharesHtml + profitHtml + '</div>' : '')
      + '</div>'
      + '<div class="stock-actions">'
      + '<button class="act-btn edit-btn" title="编辑">✎</button>'
      + '<button class="act-btn del-btn" title="删除">✕</button>'
      + '</div></div>';
  }).join('');

  container.innerHTML = indexHtml + stockHtml;

  // 总盈亏 & 总市值
  if (hasAnyPosition) {
    totalBar.style.display = 'flex';
    const tCls = totalProfit >= 0 ? 'up' : 'down';
    const tSign = totalProfit >= 0 ? '+' : '-';
    $('totalValue').className = 'total-value ' + tCls;
    $('totalValue').textContent = tSign + Math.abs(totalProfit).toFixed(2);
    totalAmountBar.style.display = 'flex';
    $('totalAmountValue').textContent = totalAmount.toFixed(2);
  } else {
    totalBar.style.display = 'none';
    totalAmountBar.style.display = 'none';
  }

  // 绑定事件
  container.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      const s = list.find(x => x.code === code);
      if (s) showForm(s);
    });
  });
  container.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const item = e.target.closest('.stock-item');
      const code = item.dataset.code;
      const s = list.find(x => x.code === code);
      if (s) {
        vscode.postMessage({ type: 'deleteStock', code });
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
function showForm(stock) {
  editCode = stock ? stock.code : null;
  $('formTitle').textContent = stock ? '编辑股票：' + stock.name : '添加股票';
  $('codeField').style.display = stock ? 'none' : 'block';
  $('codeInput').value = '';
  $('aliasInput').value = stock ? (stock.alias || '') : '';
  $('priceInput').value = stock?.purchasePrice ?? '';
  $('sharesInput').value = stock?.shares ?? '';
  const hasAlert = stock ? stock.alertEnabled : false;
  $('alertEnabledCheck').checked = hasAlert;
  $('alertFields').classList.toggle('active', hasAlert);
  $('targetPriceInput').value = stock?.targetPrice ?? '';
  $('targetChangeRateInput').value = stock?.targetChangeRate ?? '';
  $('formError').style.display = 'none';
  $('searchResults').classList.remove('active');
  selectedResult = null;
  $('listView').style.display = 'none';
  $('formView').classList.add('active');
  if (!stock) $('codeInput').focus();
}

function showList() {
  $('formView').classList.remove('active');
  $('listView').style.display = 'block';
  editCode = null;
  selectedResult = null;
}

// ── 事件绑定 ──
$('addBtn').addEventListener('click', () => showForm(null));
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

// ── 预警开关切换 ──
$('alertEnabledCheck').addEventListener('change', e => {
  $('alertFields').classList.toggle('active', e.target.checked);
});

// 点击外部关闭搜索结果
document.addEventListener('click', e => {
  if (!e.target.closest('#codeField')) {
    $('searchResults').classList.remove('active');
  }
});

$('okBtn').addEventListener('click', () => {
  const alias = $('aliasInput').value.trim();
  const purchasePrice = parseFloat($('priceInput').value) || 0;
  const shares = parseInt($('sharesInput').value) || 0;
  const alertEnabled = $('alertEnabledCheck').checked;
  const targetPrice = parseFloat($('targetPriceInput').value) || 0;
  const targetChangeRate = parseFloat($('targetChangeRateInput').value) || 0;

  if (shares > 0 && shares % 100 !== 0) {
    $('formError').textContent = '持仓数量须为100的倍数';
    $('formError').style.display = 'block';
    return;
  }

  $('formError').style.display = 'none';

  if (editCode) {
    vscode.postMessage({ type: 'editStock', code: editCode, alias, purchasePrice, shares, alertEnabled, targetPrice, targetChangeRate });
  } else {
    if (!selectedResult) {
      $('formError').textContent = '请先搜索并选择一只股票';
      $('formError').style.display = 'block';
      return;
    }
    vscode.postMessage({
      type: 'addStock',
      code: selectedResult.code,
      name: selectedResult.name,
      alias, purchasePrice, shares, alertEnabled, targetPrice, targetChangeRate,
    });
  }
});

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
