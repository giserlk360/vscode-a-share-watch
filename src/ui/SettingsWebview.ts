/**
 * SettingsWebview - 插件设置面板（嵌入侧边栏）
 * 使用 vscode.WebviewViewProvider 实现，嵌入在侧边栏的"插件设置"区域
 * 设置即时生效，每个控件变化时立即保存
 */

import * as vscode from 'vscode';
import { PluginSettings } from '../types';
import { IPriceMonitor } from '../business/PriceMonitor';
import { IStockManager } from '../data/StockManager';

/** CommentDecorator 设置同步接口 */
export interface IDecorationSettingsSync {
  setStealthMode(enabled: boolean): void;
}

export class SettingsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'settingsView';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly priceMonitor: IPriceMonitor,
    private readonly stockManager: IStockManager,
    private readonly decoratorSync?: IDecorationSettingsSync,
  ) {}

  /** VSCode 调用此方法创建/恢复 WebviewView */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._buildHtml();

    // 监听来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this._sendInit();
          break;
        case 'save':
          await this._handleSave(message.settings);
          break;
      }
    });

    // 视图变为可见时推送最新设置
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInit();
      }
    });
  }

  /** 主动推送最新设置到 Webview */
  public sendInit(): void {
    this._sendInit();
  }

  private _sendInit(): void {
    if (!this._view) { return; }
    const settings = this.priceMonitor.getSettings();
    this._view.webview.postMessage({ type: 'init', settings });
  }

  private async _handleSave(settings: Partial<PluginSettings>): Promise<void> {
    try {
      await this.priceMonitor.updateSettings(settings);
      // 同步隐蔽模式到 CommentDecorator
      if (this.decoratorSync && settings.stealthMode !== undefined) {
        this.decoratorSync.setStealthMode(!!settings.stealthMode);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`保存设置失败：${(err as Error).message}`);
    }
  }


  private _buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:12px}
.section{margin-bottom:16px}
.section-title{font-size:11px;font-weight:600;color:var(--vscode-foreground);opacity:.7;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--vscode-widget-border)}
.row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.row label{font-size:11px;color:var(--vscode-foreground)}
.row-v{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.row-v label{font-size:11px;color:var(--vscode-foreground)}
input[type=number],input[type=text],select{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:11px;padding:3px 6px;width:72px;outline:none}
input[type=number]:focus,input[type=text]:focus,select:focus{border-color:var(--vscode-focusBorder)}
input.full{width:100%;padding:4px 8px}
textarea.full{width:100%;padding:4px 8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-family:var(--vscode-font-family);outline:none}
textarea.full:focus{border-color:var(--vscode-focusBorder)}
select{width:auto;min-width:90px}
.toggle{position:relative;width:32px;height:16px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0;position:absolute}
.track{position:absolute;inset:0;background:#6c6c6c;border-radius:8px;cursor:pointer;transition:background .2s}
.track::after{content:'';position:absolute;width:12px;height:12px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform .2s}
.toggle input:checked+.track{background:var(--vscode-button-background)}
.toggle input:checked+.track::after{transform:translateX(16px)}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}
</style>
</head>
<body>
<div class="section">
  <div class="section-title">基础设置</div>
  <div class="row"><label>刷新频率（秒）</label><input type="number" id="refreshInterval" min="1" max="3600" value="10"></div>
</div>
<div class="section">
  <div class="section-title">股票列表显示内容</div>
  <div class="hint" style="margin-bottom:6px">选择股票列表中显示哪些字段</div>
  <div class="row"><label>股票代码</label><label class="toggle"><input type="checkbox" id="slShowCode"><span class="track"></span></label></div>
  <div class="row"><label>当前价格</label><label class="toggle"><input type="checkbox" id="slShowCurrentPrice"><span class="track"></span></label></div>
  <div class="row"><label>涨跌幅</label><label class="toggle"><input type="checkbox" id="slShowChangeRate"><span class="track"></span></label></div>
  <div class="row"><label>买入价格</label><label class="toggle"><input type="checkbox" id="slShowPurchasePrice"><span class="track"></span></label></div>
  <div class="row"><label>持仓数量</label><label class="toggle"><input type="checkbox" id="slShowShares"><span class="track"></span></label></div>
  <div class="row"><label>持仓盈亏</label><label class="toggle"><input type="checkbox" id="slShowProfit"><span class="track"></span></label></div>
  <div class="row"><label>持仓涨跌幅</label><label class="toggle"><input type="checkbox" id="slShowPositionChangeRate"><span class="track"></span></label></div>
  <div class="row"><label>持仓金额</label><label class="toggle"><input type="checkbox" id="slShowPositionAmount"><span class="track"></span></label></div>
  <div class="section-title" style="margin-top:8px">指数列表显示</div>
  <div class="hint" style="margin-bottom:6px">选择哪些指数显示在股票列表中</div>
  <div id="stockListKwList"></div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

let debounceTimer = null;
let currentKeywords = {};

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'init') fill(msg.settings);
});

function fill(s) {
  if (!s) return;
  $('refreshInterval').value = s.refreshInterval ?? 10;
  // 股票列表显示内容
  const sd = s.stockListDisplay || {};
  $('slShowCode').checked = sd.showCode !== false;
  $('slShowCurrentPrice').checked = sd.showCurrentPrice !== false;
  $('slShowChangeRate').checked = sd.showChangeRate !== false;
  $('slShowPurchasePrice').checked = sd.showPurchasePrice !== false;
  $('slShowShares').checked = sd.showShares !== false;
  $('slShowProfit').checked = sd.showProfit !== false;
  $('slShowPositionChangeRate').checked = !!sd.showPositionChangeRate;
  $('slShowPositionAmount').checked = !!sd.showPositionAmount;
  // 指数列表显示
  const defaultNames = ['上证指数','深证成指','创业板指','沪深300','科创50'];
  const defaultCodes = {'上证指数':'sh000001','深证成指':'sz399001','创业板指':'sz399006','沪深300':'sh000300','科创50':'sh000688'};
  currentKeywords = defaultCodes;
  stockListKw = s.stockListKeywords || {};
  renderStockListKw();
}

function read() {
  return {
    refreshInterval: parseInt($('refreshInterval').value) || 10,
    stockListDisplay: {
      showCode: $('slShowCode').checked,
      showCurrentPrice: $('slShowCurrentPrice').checked,
      showChangeRate: $('slShowChangeRate').checked,
      showPurchasePrice: $('slShowPurchasePrice').checked,
      showShares: $('slShowShares').checked,
      showProfit: $('slShowProfit').checked,
      showPositionChangeRate: $('slShowPositionChangeRate').checked,
      showPositionAmount: $('slShowPositionAmount').checked,
    },
    stockListKeywords: { ...stockListKw },
  };
}

function autoSave() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    vscode.postMessage({ type: 'save', settings: read() });
  }, 300);
}

// 为所有控件绑定即时保存
['slShowCode','slShowCurrentPrice','slShowChangeRate','slShowPurchasePrice','slShowShares','slShowProfit','slShowPositionChangeRate','slShowPositionAmount'].forEach(id => {
  $(id).addEventListener('change', autoSave);
});
['refreshInterval'].forEach(id => {
  $(id).addEventListener('input', autoSave);
});

// ── 指数列表显示 ──
let stockListKw = {};

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function renderStockListKw() {
  const container = $('stockListKwList');
  const keys = Object.entries(currentKeywords);
  if (keys.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = keys.map(([name, code]) => {
    const checked = stockListKw[name] ? 'checked' : '';
    return '<div class="row"><label>' + esc(name) + '</label><label class="toggle"><input type="checkbox" class="slkw-toggle" data-name="' + esc(name) + '" ' + checked + '><span class="track"></span></label></div>';
  }).join('');
  container.querySelectorAll('.slkw-toggle').forEach(inp => {
    inp.addEventListener('change', () => {
      stockListKw[inp.dataset.name] = inp.checked;
      autoSave();
    });
  });
}

// 通知 Extension 已就绪，请求初始数据
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
