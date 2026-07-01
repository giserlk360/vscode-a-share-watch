/**
 * 核心 TypeScript 接口定义
 * 包含插件所有核心数据结构
 */

/**
 * 股票实时数据
 * 从 API 获取并解析后的股票行情数据
 */
export interface StockData {
  /** 股票代码，带市场前缀，如 "sh600036" */
  code: string;
  /** 股票名称，如 "招商银行" */
  name: string;
  /** 当前价格 */
  currentPrice: number;
  /** 今日开盘价 */
  openPrice: number;
  /** 昨日收盘价 */
  closePrice: number;
  /** 涨跌额 */
  changeAmount: number;
  /** 涨跌幅（百分比，如 4.79 表示 +4.79%） */
  changeRate: number;
  /** 成交量（手） */
  volume: number;
  /** 是否为 ETF */
  isETF: boolean;
  /** 数据时间戳（毫秒） */
  timestamp: number;
}

/**
 * 用户添加的股票条目
 * 包含用户自定义信息和监控配置
 */
export interface StockEntry {
  /** 股票代码，带市场前缀，如 "sh600036" */
  code: string;
  /** 股票官方名称 */
  name: string;
  /** 用户自定义别名（可选） */
  alias?: string;
  /** 买入价格（可选，用于计算盈亏） */
  purchasePrice?: number;
  /** 持仓数量（可选，须为100的倍数） */
  shares?: number;
  /** 添加时间戳（毫秒） */
  addedAt: number;
}

/**
 * 注释装饰显示选项
 * 控制注释中显示哪些股票信息
 */
export interface DecorationDisplayOptions {
  /** 显示当前价格 */
  showPrice: boolean;
  /** 显示涨跌幅 */
  showChangeRate: boolean;
  /** 显示涨跌额 */
  showChangeAmount: boolean;
  /** 显示持仓盈亏 */
  showPositionProfit: boolean;
  /** 显示当日盈亏（(当前价-昨收价)×股数） */
  showDailyProfit: boolean;
}

/**
 * 股票列表显示选项
 * 控制侧边栏股票列表中显示哪些字段
 */
export interface StockListDisplayOptions {
  /** 显示股票代码 */
  showCode: boolean;
  /** 显示当前价格 */
  showCurrentPrice: boolean;
  /** 显示涨跌幅 */
  showChangeRate: boolean;
  /** 显示买入价格 */
  showPurchasePrice: boolean;
  /** 显示持仓数量 */
  showShares: boolean;
  /** 显示持仓盈亏 */
  showProfit: boolean;
  /** 显示持仓涨跌幅（相对买入价） */
  showPositionChangeRate: boolean;
  /** 显示持仓金额（当前价×股数） */
  showPositionAmount: boolean;
  /** 列表排序：null=默认, 'desc'=涨幅优先, 'asc'=跌幅优先 */
  sortOrder: null | 'desc' | 'asc';
  /** 当前激活的 Tab：'watchlist' | 'wishlist' | 'portfolio' */
  activeTab: 'watchlist' | 'wishlist' | 'portfolio';
}

/**
 * 插件全局设置
 * 持久化到 VSCode globalState
 */
export interface PluginSettings {
  /** 股票数据刷新间隔（秒），默认 5 */
  refreshInterval: number;
  /** 隐蔽模式：使股票信息颜色与注释颜色一致 */
  stealthMode: boolean;
  /** 注释装饰显示选项 */
  decorationDisplay: DecorationDisplayOptions;
  /** 股票列表显示选项 */
  stockListDisplay: StockListDisplayOptions;
  /** 是否自动将走势弱的自选股加入预购股 */
  autoWishlistEnabled: boolean;
  /** 用户自定义特殊词汇别名，key: 别名, value: 股票代码（带前缀） */
  customKeywords: Record<string, string>;
  /** 特殊词汇列表显示开关，key: 别名, value: 是否在股票列表中显示 */
  stockListKeywords: Record<string, boolean>;
}

/**
 * 导出/导入 JSON 格式
 */
export interface ExportData {
  /** 格式版本号 */
  version: string;
  /** 导出时间（ISO 8601 格式） */
  exportedAt: string;
  /** 股票列表 */
  stocks: StockEntry[];
  /** 插件设置（可选） */
  settings?: Partial<PluginSettings>;
  /** 持有股列表（可选） */
  portfolio?: StockEntry[];
}

/**
 * 内存缓存条目
 */
export interface CacheEntry {
  /** 缓存的股票数据 */
  data: StockData;
  /** 缓存时间戳（毫秒） */
  fetchedAt: number;
}

/**
 * 日K线数据
 */
export interface KlineDay {
  /** 日期，如 "2024-01-15" */
  date: string;
  /** 开盘价 */
  open: number;
  /** 收盘价 */
  close: number;
  /** 最高价 */
  high: number;
  /** 最低价 */
  low: number;
  /** 成交量 */
  volume: number;
}

/**
 * 注释扫描匹配结果
 */
export interface CommentMatch {
  /** 匹配到的股票代码 */
  code: string;
  /** 匹配到的文本范围（行号和列号） */
  range: {
    line: number;
    startChar: number;
    endChar: number;
  };
  /** 匹配类型：特殊词汇、别名、官方名称、代码 */
  matchType: 'special' | 'alias' | 'name' | 'code';
}

/**
 * 默认插件设置
 */
export const DEFAULT_SETTINGS: PluginSettings = {
  refreshInterval: 5,
  stealthMode: false,
  decorationDisplay: {
    showPrice: true,
    showChangeRate: true,
    showChangeAmount: false,
    showPositionProfit: false,
    showDailyProfit: false,
  },
  stockListDisplay: {
    showCode: true,
    showCurrentPrice: true,
    showChangeRate: true,
    showPurchasePrice: true,
    showShares: true,
    showProfit: true,
    showPositionChangeRate: true,
    showPositionAmount: true,
    sortOrder: null,
    activeTab: 'watchlist',
  },
  autoWishlistEnabled: true,
  customKeywords: {
    '上证指数': 'sh000001',
    '深证成指': 'sz399001',
    '创业板指': 'sz399006',
    '沪深300': 'sh000300',
    '科创50': 'sh000688',
  },
  stockListKeywords: { '上证指数': true },
};

/**
 * globalState 存储键名常量
 */
export const STORAGE_KEYS = {
  /** 股票列表存储键（自选股） */
  STOCKS: 'vscode-stock-monitor.stocks',
  /** 持有股存储键 */
  PORTFOLIO: 'vscode-stock-monitor.portfolio',
  /** 预购股存储键 */
  WISHLIST: 'vscode-stock-monitor.wishlist',
  /** 明日计划存储键 */
  PLAN: 'vscode-stock-monitor.plan',
  /** 插件设置存储键 */
  SETTINGS: 'vscode-stock-monitor.settings',
} as const;
