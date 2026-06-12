/**
 * VSCode 股票监控插件入口文件
 */

import * as vscode from 'vscode';
import { StockDataProvider } from './data/StockDataProvider';
import { StockManager } from './data/StockManager';
import { AlertSystem } from './business/AlertSystem';
import { PriceMonitor } from './business/PriceMonitor';
import { StatusBarCarousel } from './ui/StatusBarCarousel';
import { CommentDecorator } from './ui/CommentDecorator';
import { StockWebviewView } from './ui/StockWebviewView';
import { SettingsWebviewProvider } from './ui/SettingsWebview';

let priceMonitor: PriceMonitor | undefined;
let statusBarCarousel: StatusBarCarousel | undefined;
let commentDecorator: CommentDecorator | undefined;
let alertSystem: AlertSystem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[股票监控] 插件已激活');

  const dataProvider = new StockDataProvider();
  const stockManager = new StockManager(context);

  const tempMonitor = new PriceMonitor(dataProvider, stockManager, context);
  const currentSettings = tempMonitor.getSettings();
  tempMonitor.dispose();

  alertSystem = new AlertSystem(context, {
    mode: currentSettings.alertMode,
    popupTemplate: currentSettings.popupTemplate,
    intenseDuration: currentSettings.alertDuration,
    flashCount: currentSettings.alertFlashCount,
  });

  const initialEntries = stockManager.getAll();
  statusBarCarousel = new StatusBarCarousel(initialEntries);
  commentDecorator = new CommentDecorator(initialEntries);
  commentDecorator.activate(context);

  priceMonitor = new PriceMonitor(dataProvider, stockManager, context);
  priceMonitor.registerDecorator(commentDecorator);
  priceMonitor.registerCarousel(statusBarCarousel);
  priceMonitor.registerAlertSystem(alertSystem);

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

  if (currentSettings.carouselEnabled) {
    statusBarCarousel.setInterval(currentSettings.carouselInterval);
    statusBarCarousel.start();
  }

  priceMonitor.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('stock-monitor.refreshView', () => {
      // 触发 webview 重新发送当前列表
      stockWebviewView.refresh([]);
    }),
    vscode.commands.registerCommand('vscode-stock-monitor.toggleCarousel', async () => {
      if (!priceMonitor || !statusBarCarousel) { return; }
      const s = priceMonitor.getSettings();
      const enabled = !s.carouselEnabled;
      await priceMonitor.updateSettings({ carouselEnabled: enabled });
      if (enabled) {
        statusBarCarousel.setInterval(priceMonitor.getSettings().carouselInterval);
        statusBarCarousel.start();
        vscode.window.showInformationMessage('✅ 状态栏轮播已开启');
      } else {
        statusBarCarousel.stop();
        vscode.window.showInformationMessage('⏸️ 状态栏轮播已关闭');
      }
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
    { dispose: () => statusBarCarousel?.dispose() },
    { dispose: () => commentDecorator?.dispose() },
    { dispose: () => alertSystem?.dispose() },
  );

  console.log('[股票监控] 所有组件初始化完成');
}

export function deactivate(): void {
  priceMonitor?.dispose(); priceMonitor = undefined;
  statusBarCarousel?.dispose(); statusBarCarousel = undefined;
  commentDecorator?.dispose(); commentDecorator = undefined;
  alertSystem?.dispose(); alertSystem = undefined;
}
