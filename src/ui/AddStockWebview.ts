/**
 * AddStockWebview - 添加/编辑股票的 Webview 弹窗
 * 对应 .pen 设计稿中的"添加股票对话框" 600036
 * 512880  
 */

import * as vscode from 'vscode';
import { StockEntry } from '../types';
import { IStockManager } from '../data/StockManager';
import { IStockDataProvider } from '../data/StockDataProvider';

export interface AddStockResult {
  code: string;
  name: string;
  alias?: string;
  purchasePrice?: number;
  shares?: number;
}

export class AddStockWebview {
  private static panel: vscode.WebviewPanel | undefined;

  /**
   * 打开添加股票弹窗，返回用户填写的结果（取消则返回 undefined）
   */
  static async show(
    context: vscode.ExtensionContext,
    dataProvider: IStockDataProvider,
    stockManager: IStockManager,
    editEntry?: StockEntry, // 传入则为编辑模式
  ): Promise<void> {
    // 关闭已有面板
    if (AddStockWebview.panel) {
      AddStockWebview.panel.dispose();
    }

    const title = editEntry ? `编辑股票：${editEntry.name}` : '添加股票';

    const panel = vscode.window.createWebviewPanel(
      'stockMonitor.addStock',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );

    AddStockWebview.panel = panel;

    panel.webview.html = AddStockWebview._buildHtml(editEntry);

    // 监听消息
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'cancel') {
        panel.dispose();
        return;
      }

      if (msg.type === 'submit') {
        const { codeOrName, alias, purchasePrice, shares } = msg;

        try {
          let resolvedCode: string;
          let resolvedName: string;

          if (editEntry) {
            // 编辑模式：代码不变，只更新其他字段
            resolvedCode = editEntry.code;
            resolvedName = editEntry.name;
          } else {
            // 添加模式：解析代码
            panel.webview.postMessage({ type: 'loading', text: `正在查询 ${codeOrName}...` });

            const isPureCode = /^(sh|sz)?\d{5,6}$/i.test(codeOrName.trim());
            if (isPureCode) {
              resolvedCode = dataProvider.resolveMarketPrefix(codeOrName.trim());
              const data = await dataProvider.fetchSingle(resolvedCode);
              resolvedName = data?.name ?? codeOrName.trim();
            } else {
              const found = await dataProvider.resolveCode(codeOrName.trim());
              if (!found) {
                panel.webview.postMessage({ type: 'error', text: `未找到股票：${codeOrName}` });
                return;
              }
              resolvedCode = found;
              const data = await dataProvider.fetchSingle(resolvedCode);
              resolvedName = data?.name ?? codeOrName.trim();
            }
          }

          if (editEntry) {
            await stockManager.update(resolvedCode, {
              alias: alias?.trim() || undefined,
              purchasePrice: purchasePrice > 0 ? purchasePrice : undefined,
              shares: shares > 0 ? shares : undefined,
            });
            vscode.window.showInformationMessage(`✅ 已更新：${resolvedName}`);
          } else {
            const entry: StockEntry = {
              code: resolvedCode,
              name: resolvedName,
              alias: alias?.trim() || undefined,
              purchasePrice: purchasePrice > 0 ? purchasePrice : undefined,
              shares: shares > 0 ? shares : undefined,
              addedAt: Date.now(),
            };
            await stockManager.add(entry);
            vscode.window.showInformationMessage(`✅ 已添加：${resolvedName}（${resolvedCode}）`);
          }

          panel.dispose();
        } catch (err) {
          panel.webview.postMessage({ type: 'error', text: (err as Error).message });
        }
      }
    });

    panel.onDidDispose(() => {
      AddStockWebview.panel = undefined;
    });
  }

  private static _buildHtml(editEntry?: StockEntry): string {
    const isEdit = !!editEntry;
    const title = isEdit ? `编辑股票：${editEntry!.name}` : '添加股票';
    const codeVal = isEdit ? editEntry!.code : '';
    const aliasVal = isEdit ? (editEntry!.alias ?? '') : '';
    const priceVal = isEdit ? (editEntry!.purchasePrice ?? '') : '';
    const sharesVal = isEdit ? (editEntry!.shares ?? '') : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;justify-content:center;align-items:flex-start;padding:32px 16px}
.dialog{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-widget-border);padding:24px;width:100%;max-width:420px}
h2{font-size:14px;font-weight:600;margin-bottom:20px;color:var(--vscode-foreground)}
.field{margin-bottom:16px}
.field label{display:block;font-size:11px;color:var(--vscode-foreground);margin-bottom:6px}
.field input{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:12px;padding:7px 10px;outline:none}
.field input:focus{border-color:var(--vscode-focusBorder)}
.field input::placeholder{color:var(--vscode-input-placeholderForeground)}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px}
.btn-row{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.btn{padding:7px 18px;font-size:12px;border:none;cursor:pointer;border-radius:2px}
.btn-cancel{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border)}
.btn-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.btn:hover{opacity:.85}
.error{color:var(--vscode-errorForeground);font-size:11px;margin-top:8px;display:none}
.loading{color:var(--vscode-descriptionForeground);font-size:11px;margin-top:8px;display:none}
</style>
</head>
<body>
<div class="dialog">
  <h2>${title}</h2>
  ${!isEdit ? `
  <div class="field">
    <label>股票代码/名称：</label>
    <input id="codeOrName" placeholder="输入股票代码或名称..." value="${codeVal}" autofocus>
  </div>` : `<input type="hidden" id="codeOrName" value="${codeVal}">`}
  <div class="field">
    <label>别名（可选）：</label>
    <input id="alias" placeholder="输入别名..." value="${aliasVal}">
  </div>
  <div class="field">
    <label>买入价格：</label>
    <input id="purchasePrice" type="number" min="0" step="0.01" placeholder="输入买入价格..." value="${priceVal}">
  </div>
  <div class="field">
    <label>持仓数量（可选，须为100的倍数）：</label>
    <input id="shares" type="number" min="0" step="100" placeholder="如: 100, 200, 500..." value="${sharesVal}">
    <div class="hint">A股最小交易单位为100股（1手）</div>
  </div>
  <div class="error" id="errMsg"></div>
  <div class="loading" id="loadMsg"></div>
  <div class="btn-row">
    <button class="btn btn-cancel" id="cancelBtn">取消</button>
    <button class="btn btn-ok" id="okBtn">确定</button>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'error') { $('errMsg').textContent = msg.text; $('errMsg').style.display='block'; $('loadMsg').style.display='none'; $('okBtn').disabled=false; }
  if (msg.type === 'loading') { $('loadMsg').textContent = msg.text; $('loadMsg').style.display='block'; $('errMsg').style.display='none'; }
});

$('cancelBtn').onclick = () => vscode.postMessage({ type: 'cancel' });


$('okBtn').onclick = () => {
  const codeOrName = ($('codeOrName').value || '').trim();
  const alias = ($('alias').value || '').trim();
  const purchasePrice = parseFloat($('purchasePrice').value) || 0;
  const shares = parseInt($('shares').value) || 0;

  if (!codeOrName) { $('errMsg').textContent = '请输入股票代码或名称'; $('errMsg').style.display='block'; return; }
  if (shares > 0 && shares % 100 !== 0) { $('errMsg').textContent = '持仓数量须为100的倍数'; $('errMsg').style.display='block'; return; }

  $('errMsg').style.display='none';
  $('okBtn').disabled = true;
  vscode.postMessage({ type: 'submit', codeOrName, alias, purchasePrice, shares });
};

// 回车提交
document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) $('okBtn').click(); if (e.key === 'Escape') $('cancelBtn').click(); });
</script>
</body>
</html>`;
  }
}
