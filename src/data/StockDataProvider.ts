/**
 * StockDataProvider - 股票数据获取模块
 * 主数据源：东方财富 API（JSON格式，无乱码）
 * 备用数据源：新浪财经 API（GBK编码）
 */

import * as https from 'https';
import * as http from 'http';
import { StockData, CacheEntry } from '../types';

// ─── 接口定义 ────────────────────────────────────────────────────────────────

export interface IStockDataProvider {
  fetchBatch(codes: string[]): Promise<StockData[]>;
  fetchSingle(code: string): Promise<StockData | null>;
  resolveCode(input: string): Promise<string | null>;
  resolveMarketPrefix(code: string): string;
}

// ─── 内存缓存 ─────────────────────────────────────────────────────────────────

/** 内存缓存，key 为带前缀的股票代码（如 "sh600036"） */
type StockCache = Map<string, CacheEntry>;

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 网络请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 3000;

/** 东方财富批量行情接口 */
const EMC_BATCH_URL =
  'https://push2.eastmoney.com/api/qt/stockssort/get' +
  '?secids={codes}' +
  '&fields=f43,f44,f45,f46,f47,f48,f57,f58,f107,f169,f170' +
  '&ut=fa5fd1943c7b386f172d6893dbfba10b';

/** 东方财富搜索接口（名称→代码） */
const EMC_SEARCH_URL =
  'https://searchapi.eastmoney.com/api/suggest/get' +
  '?input={input}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8';

/** 新浪财经行情接口（备用） */
const SINA_URL = 'http://hq.sinajs.cn/list={codes}';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 发起 HTTPS/HTTP GET 请求，返回原始 Buffer（支持 GBK 解码）
 * @param url 请求地址
 * @param headers 额外请求头
 */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;

    const req = lib.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    // 设置超时
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时（>${REQUEST_TIMEOUT_MS}ms）: ${url}`));
    });

    req.on('error', reject);
  });
}

/**
 * 将 GBK Buffer 解码为 UTF-8 字符串
 * Node.js 原生不支持 GBK，使用 latin1 + 手动映射的简化方案；
 * 若环境支持 TextDecoder（Node 18+），优先使用。
 */
function decodeGBK(buf: Buffer): string {
  try {
    // Node 18+ 支持 TextDecoder('gbk')
    const decoder = new TextDecoder('gbk');
    return decoder.decode(buf);
  } catch {
    // 降级：直接 toString，可能出现乱码，但不影响数字字段解析
    return buf.toString('binary');
  }
}

// ─── 东方财富响应解析 ──────────────────────────────────────────────────────────

/**
 * 将带前缀的代码（sh600036）转换为东方财富 secid 格式（1.600036）
 */
function toSecid(code: string): string {
  const lower = code.toLowerCase();
  if (lower.startsWith('sh')) {
    return `1.${lower.slice(2)}`;
  }
  if (lower.startsWith('sz')) {
    return `0.${lower.slice(2)}`;
  }
  // 无前缀时尝试推断
  return code;
}

/**
 * 解析东方财富批量接口响应，返回 StockData 数组
 * 响应结构：{ data: { diff: [ { f43, f44, ... }, ... ] } }
 */
function parseEastMoneyResponse(json: string, requestedCodes: string[]): StockData[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error('[StockDataProvider] 东方财富响应 JSON 解析失败:', e);
    return [];
  }

  const diff: any[] = parsed?.data?.diff;
  if (!Array.isArray(diff)) {
    console.warn('[StockDataProvider] 东方财富响应 diff 字段缺失或非数组');
    return [];
  }

  const results: StockData[] = [];

  for (const item of diff) {
    try {
      // f107: 市场（1=沪，0=深）
      const market: number = item.f107;
      const rawCode: string = String(item.f57);
      const prefix = market === 1 ? 'sh' : 'sz';
      const fullCode = `${prefix}${rawCode}`;

      // 价格字段均需 ÷100
      const currentPrice = Number(item.f43) / 100;
      const highPrice    = Number(item.f44) / 100;
      const lowPrice     = Number(item.f45) / 100;
      const closePrice   = Number(item.f46) / 100;
      const volume       = Number(item.f47);
      // f48 成交额（原值，暂不使用）
      const name         = String(item.f58);
      const changeAmount = Number(item.f169) / 100;
      const changeRate   = Number(item.f170) / 100;

      // 判断是否为 ETF（代码首位为 1 或 5，且为深市）
      const isETF = (prefix === 'sz' && (rawCode.startsWith('1') || rawCode.startsWith('5')))
        || (prefix === 'sh' && rawCode.startsWith('5'));

      // 过滤无效数据（价格为 0 或 NaN 时跳过）
      if (!currentPrice || isNaN(currentPrice)) {
        console.warn(`[StockDataProvider] 跳过无效数据: ${fullCode}`);
        continue;
      }

      results.push({
        code: fullCode,
        name,
        currentPrice,
        openPrice: closePrice + changeAmount, // 开盘价 = 昨收 + 涨跌额（近似）
        closePrice,
        changeAmount,
        changeRate,
        volume,
        isETF,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[StockDataProvider] 解析单条东方财富数据失败:', e, item);
    }
  }

  return results;
}

// ─── 新浪财经响应解析（备用） ──────────────────────────────────────────────────

/**
 * 解析新浪财经 API 响应（GBK 编码文本）
 * 格式：var hq_str_sh600036="招商银行,37.20,35.50,37.10,...";
 */
function parseSinaResponse(text: string, requestedCodes: string[]): StockData[] {
  const results: StockData[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/var hq_str_([a-z]{2}\d+)="([^"]+)"/);
    if (!match) {
      continue;
    }

    const code = match[1]; // 如 "sh600036"
    const fields = match[2].split(',');

    try {
      const name         = fields[0];
      const openPrice    = parseFloat(fields[1]);
      const closePrice   = parseFloat(fields[2]);
      const currentPrice = parseFloat(fields[3]);

      if (!currentPrice || isNaN(currentPrice)) {
        console.warn(`[StockDataProvider] 新浪：跳过无效数据: ${code}`);
        continue;
      }

      // 涨跌额和涨跌幅手动计算
      const changeAmount = currentPrice - closePrice;
      const changeRate   = closePrice > 0
        ? (changeAmount / closePrice) * 100
        : 0;

      // 判断是否为 ETF
      const rawCode = code.slice(2);
      const isETF = (code.startsWith('sz') && (rawCode.startsWith('1') || rawCode.startsWith('5')))
        || (code.startsWith('sh') && rawCode.startsWith('5'));

      results.push({
        code,
        name,
        currentPrice,
        openPrice,
        closePrice,
        changeAmount,
        changeRate,
        volume: 0, // 新浪响应字段较多，此处简化
        isETF,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[StockDataProvider] 解析新浪单条数据失败:', e, line);
    }
  }

  return results;
}

// ─── StockDataProvider 主类 ───────────────────────────────────────────────────

export class StockDataProvider implements IStockDataProvider {
  /** 内存缓存 */
  private cache: StockCache = new Map();

  // ── resolveMarketPrefix ──────────────────────────────────────────────────────

  /**
   * 根据纯数字代码推断市场前缀（sh / sz）
   * 规则：
   *   - 6位，首位 6/9 → sh（沪市）
   *   - 6位，首位 0/2/3 → sz（深市）
   *   - ETF（6位，首位 1/5）→ sz
   *   - 特殊：000001 → sh000001（上证指数）
   */
  resolveMarketPrefix(code: string): string {
    const trimmed = code.trim();

    // 已带前缀则直接返回
    if (/^(sh|sz)/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    // 必须是 6 位纯数字
    if (!/^\d{6}$/.test(trimmed)) {
      console.warn(`[StockDataProvider] 无法推断市场前缀，代码格式不合法: ${trimmed}`);
      return trimmed;
    }

    const first = trimmed[0];

    // 上证指数特殊处理
    if (trimmed === '000001') {
      return `sh${trimmed}`;
    }

    // 沪市：首位 6 或 9
    if (first === '6' || first === '9') {
      return `sh${trimmed}`;
    }

    // 深市：首位 0、2、3
    if (first === '0' || first === '2' || first === '3') {
      return `sz${trimmed}`;
    }

    // ETF：首位 1 或 5（深市 ETF）
    if (first === '1' || first === '5') {
      return `sz${trimmed}`;
    }

    // 兜底：无法判断时返回原值并记录警告
    console.warn(`[StockDataProvider] 无法推断市场前缀: ${trimmed}`);
    return trimmed;
  }

  // ── resolveCode ──────────────────────────────────────────────────────────────

  /**
   * 通过股票名称（或关键词）查询对应的带前缀代码
   * 使用东方财富搜索 API
   * @param input 股票名称或关键词，如 "招商银行"
   * @returns 带前缀代码，如 "sh600036"；未找到时返回 null
   */
  async resolveCode(input: string): Promise<string | null> {
    const url = EMC_SEARCH_URL.replace('{input}', encodeURIComponent(input));

    try {
      const buf = await httpGet(url);
      const text = buf.toString('utf-8');
      const json = JSON.parse(text);

      // 响应结构：{ QuotationCodeTable: { Data: [ { Code, MktNum, ... } ] } }
      const data: any[] = json?.QuotationCodeTable?.Data;
      if (!Array.isArray(data) || data.length === 0) {
        console.warn(`[StockDataProvider] resolveCode 未找到结果: ${input}`);
        return null;
      }

      const first = data[0];
      const rawCode: string = String(first.Code);
      // MktNum: 1=沪, 0=深
      const mktNum: number = Number(first.MktNum);
      const prefix = mktNum === 1 ? 'sh' : 'sz';

      return `${prefix}${rawCode}`;
    } catch (e) {
      console.error(`[StockDataProvider] resolveCode 请求失败 (${input}):`, e);
      return null;
    }
  }

  // ── fetchBatch ───────────────────────────────────────────────────────────────

  /**
   * 批量获取股票数据
   * 优先使用东方财富 API，失败时回退新浪财经 API，
   * 两者均失败时返回缓存数据。
   * @param codes 带前缀的股票代码数组，如 ["sh600036", "sz000001"]
   */
  async fetchBatch(codes: string[]): Promise<StockData[]> {
    if (codes.length === 0) {
      return [];
    }

    // 1. 尝试东方财富 API
    try {
      const results = await this._fetchFromEastMoney(codes);
      if (results.length > 0) {
        // 更新缓存
        for (const item of results) {
          this.cache.set(item.code, { data: item, fetchedAt: Date.now() });
        }
        return results;
      }
    } catch (e) {
      console.warn('[StockDataProvider] 东方财富 API 失败，尝试新浪备用:', e);
    }

    // 2. 回退新浪财经 API
    try {
      const results = await this._fetchFromSina(codes);
      if (results.length > 0) {
        for (const item of results) {
          this.cache.set(item.code, { data: item, fetchedAt: Date.now() });
        }
        return results;
      }
    } catch (e) {
      console.warn('[StockDataProvider] 新浪 API 也失败，使用缓存数据:', e);
    }

    // 3. 两者均失败，返回缓存
    return this._getFromCache(codes);
  }

  // ── fetchSingle ──────────────────────────────────────────────────────────────

  /**
   * 获取单只股票数据
   * @param code 带前缀的股票代码，如 "sh600036"
   */
  async fetchSingle(code: string): Promise<StockData | null> {
    const results = await this.fetchBatch([code]);
    return results.length > 0 ? results[0] : null;
  }

  // ── 私有方法 ─────────────────────────────────────────────────────────────────

  /**
   * 从东方财富 API 批量拉取数据
   */
  private async _fetchFromEastMoney(codes: string[]): Promise<StockData[]> {
    // 将带前缀代码转换为 secid 格式，逗号拼接
    const secids = codes.map(toSecid).join(',');
    const url = EMC_BATCH_URL.replace('{codes}', encodeURIComponent(secids));

    const buf = await httpGet(url);
    const text = buf.toString('utf-8');
    return parseEastMoneyResponse(text, codes);
  }

  /**
   * 从新浪财经 API 批量拉取数据（备用）
   * 需要设置 Referer 头，响应为 GBK 编码
   */
  private async _fetchFromSina(codes: string[]): Promise<StockData[]> {
    // 新浪使用带前缀的代码，逗号拼接
    const codeList = codes.join(',');
    const url = SINA_URL.replace('{codes}', codeList);

    const buf = await httpGet(url, {
      Referer: 'http://finance.sina.com.cn',
    });

    const text = decodeGBK(buf);
    return parseSinaResponse(text, codes);
  }

  /**
   * 从内存缓存中取出指定代码的数据
   * 网络全部失败时的最后兜底
   */
  private _getFromCache(codes: string[]): StockData[] {
    const results: StockData[] = [];
    for (const code of codes) {
      const entry = this.cache.get(code);
      if (entry) {
        console.warn(`[StockDataProvider] 使用缓存数据: ${code}（缓存时间: ${new Date(entry.fetchedAt).toLocaleTimeString()}）`);
        results.push(entry.data);
      } else {
        console.warn(`[StockDataProvider] 无缓存数据: ${code}`);
      }
    }
    return results;
  }

  /**
   * 获取当前缓存（供测试或外部读取）
   */
  getCache(): StockCache {
    return this.cache;
  }

  /**
   * 手动写入缓存（供测试注入）
   */
  setCache(code: string, entry: CacheEntry): void {
    this.cache.set(code, entry);
  }
}
