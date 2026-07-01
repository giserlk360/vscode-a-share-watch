/**
 * VSCode 股票监控插件入口文件
 */

import * as vscode from 'vscode';
import { StockDataProvider } from './data/StockDataProvider';
import { StockManager } from './data/StockManager';
import { PriceMonitor } from './business/PriceMonitor';
import { CommentDecorator } from './ui/CommentDecorator';
import { StockWebviewView } from './ui/StockWebviewView';
import { SettingsWebviewProvider } from './ui/SettingsWebview';

let priceMonitor: PriceMonitor | undefined;
let commentDecorator: CommentDecorator | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[股票监控] 插件已激活');

  const dataProvider = new StockDataProvider();
  const stockManager = new StockManager(context);

  const initialEntries = stockManager.getAll();
  const portfolioEntries = stockManager.getPortfolio();
  const wishlistEntries = stockManager.getWishlist();
  const allInitial = [...initialEntries, ...portfolioEntries, ...wishlistEntries];
  commentDecorator = new CommentDecorator(allInitial);
  commentDecorator.activate(context);

  priceMonitor = new PriceMonitor(dataProvider, stockManager, context);
  priceMonitor.registerDecorator(commentDecorator);

  // 股票列表侧边栏 Webview
  const stockWebviewView = new StockWebviewView(context, stockManager, dataProvider, priceMonitor);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StockWebviewView.viewType, stockWebviewView),
  );
  priceMonitor.registerDecorator({ triggerUpdate: (stocks) => stockWebviewView.refresh(stocks) });

  // 设置面板侧边栏 Webview
  const settingsProvider = new SettingsWebviewProvider(context, priceMonitor, stockManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsWebviewProvider.viewType, settingsProvider),
  );

  priceMonitor.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('stock-monitor.refreshView', () => {
      // 触发 webview 重新发送当前列表
      stockWebviewView.refresh([]);
    }),
    vscode.commands.registerCommand('vscode-stock-monitor.toggleStealthMode', async () => {
      if (!priceMonitor || !commentDecorator) { return; }
      const s = priceMonitor.getSettings();
      const stealth = !s.stealthMode;
      await priceMonitor.updateSettings({ stealthMode: stealth });
      commentDecorator.setStealthMode(stealth);
      vscode.window.showInformationMessage(stealth ? '🕵️ 隐蔽模式已开启' : '👁️ 隐蔽模式已关闭');
    }),
    vscode.commands.registerCommand('vscode-stock-monitor.openSettings', () => {
      vscode.commands.executeCommand('settingsView.focus');
    }),
    { dispose: () => priceMonitor?.dispose() },
    { dispose: () => commentDecorator?.dispose() },
  );

  console.log('[股票监控] 所有组件初始化完成');
}

export function deactivate(): void {
  priceMonitor?.dispose(); priceMonitor = undefined;
  commentDecorator?.dispose(); commentDecorator = undefined;
}
