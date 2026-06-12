/**
 * VSCode API Mock
 * 用于单元测试和属性测试，避免依赖真实 VSCode 环境
 */

// 模拟 ExtensionContext
export class MockExtensionContext {
  private storage = new Map<string, unknown>();

  globalState = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return (this.storage.get(key) as T) ?? defaultValue;
    },
    update: async (key: string, value: unknown): Promise<void> => {
      this.storage.set(key, value);
    },
    keys: (): readonly string[] => {
      return Array.from(this.storage.keys());
    },
    setKeysForSync: (_keys: readonly string[]): void => {},
  };

  workspaceState = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return defaultValue;
    },
    update: async (_key: string, _value: unknown): Promise<void> => {},
    keys: (): readonly string[] => [],
    setKeysForSync: (_keys: readonly string[]): void => {},
  };

  subscriptions: { dispose(): unknown }[] = [];
  extensionPath = '/mock/extension/path';
  extensionUri = { fsPath: '/mock/extension/path' };
  storagePath = '/mock/storage/path';
  globalStoragePath = '/mock/global/storage/path';
  logPath = '/mock/log/path';
}

// 模拟 window 对象
export const window = {
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  createStatusBarItem: jest.fn().mockReturnValue({
    text: '',
    tooltip: '',
    command: '',
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  }),
  createTextEditorDecorationType: jest.fn().mockReturnValue({
    dispose: jest.fn(),
  }),
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  onDidChangeTextEditorSelection: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  createOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    append: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  }),
};

// 模拟 workspace 对象
export const workspace = {
  getConfiguration: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  }),
  onDidChangeTextDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

// 模拟 commands 对象
export const commands = {
  registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  executeCommand: jest.fn().mockResolvedValue(undefined),
};

// 模拟 StatusBarAlignment 枚举
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// 模拟 TreeItemCollapsibleState 枚举
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

// 模拟 TreeItem 类
export class TreeItem {
  label: string;
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  command?: unknown;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

// 模拟 EventEmitter 类
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) { this.listeners.splice(idx, 1); }
    }};
  };

  fire(data: T): void {
    this.listeners.forEach(l => l(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// 模拟 Uri 类
export class Uri {
  static file(path: string): Uri {
    return new Uri(path);
  }
  static parse(value: string): Uri {
    return new Uri(value);
  }
  constructor(public fsPath: string) {}
  toString(): string { return this.fsPath; }
}

// 模拟 Range 类
export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

// 模拟 Position 类
export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

// 模拟 ThemeColor 类
export class ThemeColor {
  constructor(public id: string) {}
}

// 模拟 extensions 对象
export const extensions = {
  getExtension: jest.fn().mockReturnValue(undefined),
};

export default {
  window,
  workspace,
  commands,
  StatusBarAlignment,
  TreeItemCollapsibleState,
  TreeItem,
  EventEmitter,
  Uri,
  Range,
  Position,
  ThemeColor,
  extensions,
  MockExtensionContext,
};
