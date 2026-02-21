"""
CSV 亲戚关系数据加载器
从 relationship_table.csv 加载并解析为多级匹配字典
"""
import csv
import os
import re
from typing import Dict, List, Tuple, Optional

# 数据文件路径
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CSV_PATH = os.path.join(DATA_DIR, "relationship_table.csv")


def _parse_csv_row(row: list) -> Optional[dict]:
    """解析 CSV 一行，返回结构化数据"""
    if len(row) < 3:
        return None
    category = row[0].strip()
    chain = row[1].strip().strip('"') if row[1] else ""
    title = row[2].strip()
    aliases = row[3].strip() if len(row) > 3 and row[3] else title
    return {
        "category": category,
        "chain": chain,
        "title": title,
        "aliases": [a.strip() for a in aliases.split("、") if a.strip()],
    }


class KinshipData:
    """
    亲戚关系数据存储，加载一次后缓存。
    
    数据分为以下几层：
    - primary_rules:   主要关系 — 精确查表 (chain -> title)
    - combined_rules:  并称关系 — 含 [A|B] 语法的模糊匹配
    - branch_rules:    分支关系 — 含 {G1}, {M0} 等模板变量
    - input_rules:     输入关系 — 不分长幼的简化形式 (xb -> 兄弟)
    - prefix_rules:    分支前缀 — 用于组合称谓修饰
    - pair_rules:      关系合称 — 双向称谓对
    - dialect_rules:   方言称呼
    """

    def __init__(self):
        self.primary_rules: Dict[str, dict] = {}      # chain_str -> {title, aliases}
        self.combined_rules: List[dict] = []           # [{pattern, chain, title, aliases}]
        self.branch_rules: List[dict] = []             # [{pattern, chain, title, aliases}]
        self.input_rules: Dict[str, dict] = {}
        self.prefix_rules: List[dict] = []
        self.pair_rules: List[dict] = []
        self.dialect_rules: Dict[str, List[dict]] = {} # dialect_name -> [rules]
        self._loaded = False

    def load(self):
        """从 CSV 加载数据"""
        if self._loaded:
            return
        
        with open(CSV_PATH, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader)  # 跳过表头
            
            for row in reader:
                parsed = _parse_csv_row(row)
                if not parsed or not parsed["chain"]:
                    continue
                
                cat = parsed["category"]
                chain = parsed["chain"]
                info = {"title": parsed["title"], "aliases": parsed["aliases"], "chain": chain}
                
                if cat == "主要关系":
                    self.primary_rules[chain] = info
                elif cat == "并称关系":
                    self.combined_rules.append(info)
                elif cat == "分支关系":
                    self.branch_rules.append(info)
                elif cat == "输入关系":
                    self.input_rules[chain] = info
                elif cat == "分支前缀":
                    self.prefix_rules.append(info)
                elif cat == "关系合称":
                    self.pair_rules.append(info)
                elif cat.endswith("方言"):
                    dialect_name = cat
                    if dialect_name not in self.dialect_rules:
                        self.dialect_rules[dialect_name] = []
                    self.dialect_rules[dialect_name].append(info)
        
        self._loaded = True
        print(f"[KinshipData] 已加载: 主要关系={len(self.primary_rules)}, "
              f"并称={len(self.combined_rules)}, 分支={len(self.branch_rules)}, "
              f"输入={len(self.input_rules)}, 前缀={len(self.prefix_rules)}, "
              f"合称={len(self.pair_rules)}, 方言={sum(len(v) for v in self.dialect_rules.values())}")

    def lookup_primary(self, chain: str) -> Optional[dict]:
        """精确查找主要关系"""
        return self.primary_rules.get(chain)

    def lookup_combined(self, chain: str) -> Optional[dict]:
        """
        匹配并称关系
        并称关系使用 [A|B] 语法表示 "A 或 B 均可"
        例如 [f|m] 表示 f 或 m 都匹配
        """
        for rule in self.combined_rules:
            if _match_combined_pattern(rule["chain"], chain):
                return rule
        return None

    def lookup_branch(self, chain: str) -> Optional[dict]:
        """
        匹配分支关系
        分支关系使用模板变量如 {G1}, {G0}, {M0} 等
        需要展开模板后进行匹配
        """
        for rule in self.branch_rules:
            if _match_branch_pattern(rule["chain"], chain):
                return rule
        return None


# ========== 模式匹配工具 ==========

# 模板变量定义 - 每个变量代表可替换的中间环节
TEMPLATE_VARS = {
    "{G0}":   [""],              # 自身（空路径）
    "{G1}":   ["f", "m"],         # 一级父母（父或母）
    "{G1M}":  ["f"],              # 父方
    "{G1W}":  ["m"],              # 母方
    "{G2}":   ["f,f", "f,m", "m,f", "m,m"],  # 二级祖辈
    "{M0}":   ["h", "w"],         # 配偶
    "{M1M}":  ["h,f", "w,f"],     # 配偶的父方
    "{M1W}":  ["h,m", "w,m"],     # 配偶的母方
    "{M2M}":  ["h,f,f", "h,f,m", "w,f,f", "w,f,m",
               "h,m,f", "h,m,m", "w,m,f", "w,m,m"],  # 配偶的祖辈(父系)
    "{M2W}":  ["h,m,f", "h,m,m", "w,m,f", "w,m,m"],  # 配偶的祖辈(母系)
    "{M-1}":  ["s", "d"],         # 子女
}


def _match_combined_pattern(pattern: str, chain: str) -> bool:
    """
    匹配并称关系中的 [A|B] 语法
    [f|m] 表示该位置可以是 f 或 m
    """
    regex = _combined_pattern_to_regex(pattern)
    if regex is None:
        return False
    return regex.fullmatch(chain) is not None


_combined_regex_cache: Dict[str, Optional[re.Pattern]] = {}

def _combined_pattern_to_regex(pattern: str) -> Optional[re.Pattern]:
    """将并称模式 [A|B] 转为正则"""
    if pattern in _combined_regex_cache:
        return _combined_regex_cache[pattern]
    
    try:
        result = ""
        i = 0
        while i < len(pattern):
            if pattern[i] == '[':
                j = pattern.index(']', i)
                alternatives = pattern[i+1:j].split('|')
                escaped = [re.escape(a) for a in alternatives]
                result += "(?:" + "|".join(escaped) + ")"
                i = j + 1
            else:
                result += re.escape(pattern[i])
                i += 1
        
        compiled = re.compile(result)
        _combined_regex_cache[pattern] = compiled
        return compiled
    except (ValueError, re.error):
        _combined_regex_cache[pattern] = None
        return None


def _match_branch_pattern(pattern: str, chain: str) -> bool:
    """
    匹配分支关系中的模板变量
    {G1} -> f 或 m
    {G0} -> (空)
    同时也支持 [A|B] 语法和 &o/&l 后缀
    """
    # 先展开模板变量为可能的具体路径
    expanded = _expand_template(pattern)
    for exp in expanded:
        if _match_combined_pattern(exp, chain):
            return True
    return False


def _expand_template(pattern: str) -> List[str]:
    """展开模板变量，返回所有可能的具体路径"""
    # 找到第一个模板变量
    match = re.search(r'\{[^}]+\}', pattern)
    if not match:
        return [pattern]
    
    var = match.group()
    if var not in TEMPLATE_VARS:
        return [pattern]
    
    results = []
    for replacement in TEMPLATE_VARS[var]:
        if replacement:
            # 替换模板变量
            new_pattern = pattern[:match.start()] + replacement + pattern[match.end():]
        else:
            # 空替换，需要处理逗号
            before = pattern[:match.start()].rstrip(',')
            after = pattern[match.end():].lstrip(',')
            if before and after:
                new_pattern = before + ',' + after
            else:
                new_pattern = before + after
        
        # 递归展开剩余模板
        results.extend(_expand_template(new_pattern))
    
    return results


# ========== 单例 ==========
_data_instance: Optional[KinshipData] = None

def get_kinship_data() -> KinshipData:
    """获取全局单例"""
    global _data_instance
    if _data_instance is None:
        _data_instance = KinshipData()
        _data_instance.load()
    return _data_instance
