/**
 * CSV 亲戚关系数据加载器 (纯前端版)
 * 从 relationship_table.csv 加载并解析为多级匹配字典
 */

export interface KinshipRule {
  title: string;
  aliases: string[];
  chain: string;
}

// 模板变量定义
const TEMPLATE_VARS: Record<string, string[]> = {
  '{G0}':   [''],
  '{G1}':   ['f', 'm'],
  '{G1M}':  ['f'],
  '{G1W}':  ['m'],
  '{G2}':   ['f,f', 'f,m', 'm,f', 'm,m'],
  '{M0}':   ['h', 'w'],
  '{M1M}':  ['h,f', 'w,f'],
  '{M1W}':  ['h,m', 'w,m'],
  '{M2M}':  ['h,f,f', 'h,f,m', 'w,f,f', 'w,f,m', 'h,m,f', 'h,m,m', 'w,m,f', 'w,m,m'],
  '{M2W}':  ['h,m,f', 'h,m,m', 'w,m,f', 'w,m,m'],
  '{M-1}':  ['s', 'd'],
  '{M-2}':  ['s,s', 's,d', 'd,s', 'd,d'],
};

// ========== 模式匹配工具 ==========

const combinedRegexCache = new Map<string, RegExp | null>();

function combinedPatternToRegex(pattern: string): RegExp | null {
  const cached = combinedRegexCache.get(pattern);
  if (cached !== undefined) return cached;

  try {
    let result = '';
    let i = 0;
    while (i < pattern.length) {
      if (pattern[i] === '[') {
        const j = pattern.indexOf(']', i);
        if (j === -1) throw new Error('unmatched [');
        const alternatives = pattern.substring(i + 1, j).split('|');
        const escaped = alternatives.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        result += '(?:' + escaped.join('|') + ')';
        i = j + 1;
      } else {
        result += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        i++;
      }
    }
    const compiled = new RegExp('^' + result + '$');
    combinedRegexCache.set(pattern, compiled);
    return compiled;
  } catch {
    combinedRegexCache.set(pattern, null);
    return null;
  }
}

function matchCombinedPattern(pattern: string, chain: string): boolean {
  const regex = combinedPatternToRegex(pattern);
  if (!regex) return false;
  return regex.test(chain);
}

function expandTemplate(pattern: string): string[] {
  const match = pattern.match(/\{[^}]+\}/);
  if (!match) return [pattern];

  const varName = match[0];
  const replacements = TEMPLATE_VARS[varName];
  if (!replacements) return [pattern];

  const results: string[] = [];
  for (const replacement of replacements) {
    let newPattern: string;
    if (replacement) {
      newPattern = pattern.substring(0, match.index!) + replacement + pattern.substring(match.index! + varName.length);
    } else {
      const before = pattern.substring(0, match.index!).replace(/,+$/, '');
      const after = pattern.substring(match.index! + varName.length).replace(/^,+/, '');
      if (before && after) {
        newPattern = before + ',' + after;
      } else {
        newPattern = before + after;
      }
    }
    results.push(...expandTemplate(newPattern));
  }
  return results;
}

function matchBranchPattern(pattern: string, chain: string): boolean {
  const expanded = expandTemplate(pattern);
  for (const exp of expanded) {
    if (matchCombinedPattern(exp, chain)) return true;
  }
  return false;
}

// ========== CSV 解析 ==========

function parseCsvRow(row: string[]): { category: string; chain: string; title: string; aliases: string[] } | null {
  if (row.length < 3) return null;
  const category = row[0].trim();
  const chain = row[1] ? row[1].trim().replace(/^"|"$/g, '') : '';
  const title = row[2].trim();
  const aliasStr = row.length > 3 && row[3] ? row[3].trim() : title;
  const aliases = aliasStr.split('、').map(a => a.trim()).filter(Boolean);
  return { category, chain, title, aliases };
}

/** 简易 CSV 行解析器（支持引号内逗号） */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ========== KinshipData 类 ==========

export class KinshipData {
  primaryRules = new Map<string, KinshipRule>();
  combinedRules: KinshipRule[] = [];
  branchRules: KinshipRule[] = [];
  inputRules = new Map<string, KinshipRule>();
  prefixRules: KinshipRule[] = [];
  pairRules: KinshipRule[] = [];
  dialectRules = new Map<string, KinshipRule[]>();
  private _loaded = false;

  async load(): Promise<void> {
    if (this._loaded) return;

    const resp = await fetch(import.meta.env.BASE_URL + 'relationship_table.csv');
    const text = await resp.text();
    const lines = text.split('\n');

    // 跳过表头
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = parseCsvLine(line);
      const parsed = parseCsvRow(row);
      if (!parsed || !parsed.chain) continue;

      const { category, chain, title, aliases } = parsed;
      const info: KinshipRule = { title, aliases, chain };

      if (category === '主要关系') {
        this.primaryRules.set(chain, info);
      } else if (category === '并称关系') {
        this.combinedRules.push(info);
      } else if (category === '分支关系') {
        this.branchRules.push(info);
      } else if (category === '输入关系') {
        this.inputRules.set(chain, info);
      } else if (category === '分支前缀') {
        this.prefixRules.push(info);
      } else if (category === '关系合称') {
        this.pairRules.push(info);
      } else if (category.endsWith('方言')) {
        if (!this.dialectRules.has(category)) {
          this.dialectRules.set(category, []);
        }
        this.dialectRules.get(category)!.push(info);
      }
    }
    this._loaded = true;
  }

  lookupPrimary(chain: string): KinshipRule | undefined {
    return this.primaryRules.get(chain);
  }

  lookupCombined(chain: string): KinshipRule | undefined {
    for (const rule of this.combinedRules) {
      if (matchCombinedPattern(rule.chain, chain)) return rule;
    }
    return undefined;
  }

  lookupBranch(chain: string): KinshipRule | undefined {
    for (const rule of this.branchRules) {
      if (matchBranchPattern(rule.chain, chain)) return rule;
    }
    return undefined;
  }
}

// ========== 单例 ==========

let _instance: KinshipData | null = null;
let _loadPromise: Promise<KinshipData> | null = null;

export async function getKinshipData(): Promise<KinshipData> {
  if (_instance && _instance['_loaded']) return _instance;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    _instance = new KinshipData();
    await _instance.load();
    return _instance;
  })();
  return _loadPromise;
}
