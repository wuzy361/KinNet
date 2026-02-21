"""
亲戚称谓推导引擎
基于 NetworkX 有向图 + CSV 多级匹配
"""
import networkx as nx
from typing import Optional

from .kinship_loader import get_kinship_data


def _build_graph(nodes: list, edges: list):
    """构建有向图，返回 (graph, node_data_dict)"""
    G = nx.DiGraph()
    node_data = {}
    
    for n in nodes:
        nid = n["id"]
        node_data[nid] = n
        G.add_node(nid, **n)
    
    for e in edges:
        if e["label"] == "parent_of":
            G.add_edge(e["source"], e["target"], relation="parent_of")
        elif e["label"] == "spouse_of":
            G.add_edge(e["source"], e["target"], relation="spouse_of")
            G.add_edge(e["target"], e["source"], relation="spouse_of")
    
    return G, node_data


def _find_path(G: nx.DiGraph, source_id: str, target_id: str) -> Optional[list]:
    """在无向版图中找最短路径"""
    U = G.to_undirected()
    try:
        return nx.shortest_path(U, source=source_id, target=target_id)
    except nx.NetworkXNoPath:
        return None


def _path_to_graph_signature(G: nx.DiGraph, path: list, node_data: dict) -> list:
    """
    将图路径转为 (action, gender) 的签名序列
    action: parent / child / spouse
    gender: M / F
    """
    signature = []
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        v_gender = node_data[v].get("gender", "M")
        
        if G.has_edge(v, u) and G[v][u]["relation"] == "parent_of":
            # v 是 u 的父母 -> 从 u 的角度看，v 是 parent
            signature.append(("parent", v_gender))
        elif G.has_edge(u, v) and G[u][v]["relation"] == "parent_of":
            # u 是 v 的父母 -> 从 u 的角度看，v 是 child
            signature.append(("child", v_gender))
        elif G.has_edge(u, v) and G[u][v]["relation"] == "spouse_of":
            signature.append(("spouse", v_gender))
    
    return signature


def _signature_to_chain(signature: list, source_node: dict, path: list, node_data: dict) -> str:
    """
    将图签名转为 CSV 编码链
    
    CSV 编码对照:
      parent(M) -> f    (父)
      parent(F) -> m    (母)
      child(M)  -> s    (子)
      child(F)  -> d    (女)
      spouse(M) -> h    (夫)
      spouse(F) -> w    (妻)
    
    同辈关系编码规则:
      1. 直接同辈（整条路径就是一个 parent→child）: 
         根据 x 坐标 → ob/lb/os/ls，无位置信息 → xb/xs
      2. 非直接同辈（中间环节的 parent→child）:
         始终用 xb/xs（CSV 数据中间用的是 xb/xs）
      3. 末尾的 s/d 如果和 source 同辈（同 y 坐标）:
         根据 x 坐标加 &o/&l 后缀
    """
    ACTION_MAP = {
        ("parent", "M"): "f",
        ("parent", "F"): "m",
        ("child", "M"):  "s",
        ("child", "F"):  "d",
        ("spouse", "M"): "h",
        ("spouse", "F"): "w",
    }
    
    chain_parts = []
    i = 0
    while i < len(signature):
        action, gender = signature[i]
        
        # 检测同辈关系: parent -> child 模式
        if (action == "parent" and i + 1 < len(signature) 
            and signature[i + 1][0] == "child"):
            next_action, next_gender = signature[i + 1]
            
            is_direct = (i == 0 and i + 2 == len(signature))
            
            if is_direct:
                # 直接同辈：用位置判断 ob/lb/os/ls
                from_node_id = path[i]
                to_node_id = path[i + 2]
                from_data = node_data.get(from_node_id, {})
                to_data = node_data.get(to_node_id, {})
                from_pos = from_data.get("position", {})
                to_pos = to_data.get("position", {})
                from_x = from_pos.get("x") if isinstance(from_pos, dict) else None
                to_x = to_pos.get("x") if isinstance(to_pos, dict) else None
                
                if from_x is not None and to_x is not None and from_x != to_x:
                    if next_gender == "M":
                        chain_parts.append("ob" if to_x < from_x else "lb")
                    else:
                        chain_parts.append("os" if to_x < from_x else "ls")
                else:
                    chain_parts.append("xb" if next_gender == "M" else "xs")
            else:
                # 非直接同辈（中间环节）: 始终用 xb/xs
                chain_parts.append("xb" if next_gender == "M" else "xs")
            i += 2
            continue
        
        code = ACTION_MAP.get((action, gender))
        if code:
            chain_parts.append(code)
        i += 1
    
    # 处理末尾 s/d 的长幼标记：
    # 当末尾是 s 或 d，且目标节点和 source 节点在同一行（y 坐标相近），
    # 根据 x 坐标判断长幼并加上 &o/&l 后缀
    if chain_parts and chain_parts[-1] in ("s", "d") and len(path) >= 2:
        source_data = node_data.get(path[0], {})
        target_data = node_data.get(path[-1], {})
        src_pos = source_data.get("position", {})
        tgt_pos = target_data.get("position", {})
        
        if isinstance(src_pos, dict) and isinstance(tgt_pos, dict):
            src_x = src_pos.get("x")
            src_y = src_pos.get("y")
            tgt_x = tgt_pos.get("x")
            tgt_y = tgt_pos.get("y")
            
            # 同一行（y 坐标差在一个网格以内 = 同辈）且 x 不同
            if (src_x is not None and tgt_x is not None 
                and src_y is not None and tgt_y is not None
                and abs(src_y - tgt_y) < 100 and src_x != tgt_x):
                chain_parts[-1] += "&o" if tgt_x < src_x else "&l"
    
    return ",".join(chain_parts)


def _try_with_elder_younger(chain: str, source_node: dict, target_node: dict) -> list:
    """
    生成同辈关系的各种变体链，用于按优先级匹配。
    
    处理两种情况:
    1. 链中含有 ob/lb/os/ls/xb/xs → 生成互相替换的变体
    2. 链末尾的 s&o/s&l/d&o/d&l → 生成不带后缀的变体
    """
    parts = chain.split(",")
    
    # 找出所有同辈位置（ob/lb/os/ls/xb/xs）
    sibling_indices = [i for i, p in enumerate(parts) if p in ("ob", "lb", "os", "ls", "xb", "xs")]
    
    # 检查末尾是否有 &o/&l 后缀
    has_elder_younger_suffix = parts[-1].endswith("&o") or parts[-1].endswith("&l") if parts else False
    
    if not sibling_indices and not has_elder_younger_suffix:
        return [chain]
    
    # 生成同辈变体
    VARIANTS_MAP = {
        "ob": ["ob", "xb", "s&o"],
        "lb": ["lb", "xb", "s&l"],
        "os": ["os", "xs", "d&o"],
        "ls": ["ls", "xs", "d&l"],
        "xb": ["xb", "s&o", "s&l", "ob", "lb"],
        "xs": ["xs", "d&o", "d&l", "os", "ls"],
    }
    
    def _generate(idx: int, current_parts: list) -> list:
        if idx >= len(sibling_indices):
            return [",".join(current_parts)]
        
        pos = sibling_indices[idx]
        original = parts[pos]
        results = []
        seen = set()
        for variant in VARIANTS_MAP.get(original, [original]):
            new_parts = current_parts[:]
            new_parts[pos] = variant
            for r in _generate(idx + 1, new_parts):
                if r not in seen:
                    seen.add(r)
                    results.append(r)
        return results
    
    base_variants = _generate(0, list(parts)) if sibling_indices else [chain]
    
    # 对末尾 &o/&l 后缀生成变体
    all_variants = []
    seen = set()
    for v in base_variants:
        # 原始版本
        if v not in seen:
            seen.add(v)
            all_variants.append(v)
        # 去掉末尾 &o/&l 的版本
        v_parts = v.split(",")
        if v_parts[-1].endswith("&o") or v_parts[-1].endswith("&l"):
            stripped = v_parts[:]
            stripped[-1] = stripped[-1].split("&")[0]
            s = ",".join(stripped)
            if s not in seen:
                seen.add(s)
                all_variants.append(s)
    
    # 确保原始链排在第一位
    if chain in all_variants:
        all_variants.remove(chain)
    all_variants.insert(0, chain)
    
    return all_variants


def _get_rank_among_siblings(G: nx.DiGraph, node_data: dict, target_id: str) -> tuple:
    """
    计算 target 节点在其同辈（共享至少一个父母、同性别）中的排行。
    如果 target 自身无父母但有配偶，则使用配偶的排行。
    
    返回 (rank, total)：
      rank: 从1开始的排行（按 x 坐标从小到大）
      total: 同辈总人数
    如果无法计算，返回 (0, 0)
    """
    rank, total = _get_direct_rank(G, node_data, target_id)
    if total >= 2:
        return (rank, total)
    
    # 回退：找配偶，用配偶的排行
    for neighbor in G.successors(target_id):
        edge_data = G.get_edge_data(target_id, neighbor)
        if edge_data and edge_data.get("relation") == "spouse_of":
            r, t = _get_direct_rank(G, node_data, neighbor)
            if t >= 2:
                return (r, t)
    for neighbor in G.predecessors(target_id):
        edge_data = G.get_edge_data(neighbor, target_id)
        if edge_data and edge_data.get("relation") == "spouse_of":
            r, t = _get_direct_rank(G, node_data, neighbor)
            if t >= 2:
                return (r, t)
    
    return (0, 0)


def _get_direct_rank(G: nx.DiGraph, node_data: dict, target_id: str) -> tuple:
    """计算 target 在其父母的同性别子女中的排行"""
    target = node_data.get(target_id)
    if not target:
        return (0, 0)
    
    target_gender = target.get("gender", "M")
    
    # 找 target 的所有父母节点
    parents = []
    for pred in G.predecessors(target_id):
        edge_data = G.get_edge_data(pred, target_id)
        if edge_data and edge_data.get("relation") == "parent_of":
            parents.append(pred)
    
    if not parents:
        return (0, 0)
    
    # 找所有共享至少一个父母、同性别的同辈节点（包括 target 自己）
    siblings = set()
    for parent_id in parents:
        for child_id in G.successors(parent_id):
            edge_data = G.get_edge_data(parent_id, child_id)
            if edge_data and edge_data.get("relation") == "parent_of":
                child = node_data.get(child_id)
                if child and child.get("gender") == target_gender:
                    siblings.add(child_id)
    
    if len(siblings) <= 1:
        return (0, 0)
    
    # 按 x 坐标从小到大排序
    def get_x(nid):
        pos = node_data.get(nid, {}).get("position", {})
        if isinstance(pos, dict):
            return pos.get("x", 0)
        return 0
    
    sorted_siblings = sorted(siblings, key=get_x)
    
    try:
        rank = sorted_siblings.index(target_id) + 1
    except ValueError:
        return (0, 0)
    
    return (rank, len(sorted_siblings))


# 中文数字映射
_CN_NUMBERS = {1: "大", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九", 10: "十"}


# 称呼 → 加排行后的格式 (前缀替换, 后缀)
# 例如 "哥哥" → rank=2 → "二哥"
_RANK_RULES = {
    "哥哥":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}哥",
    "弟弟":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}弟",
    "姐姐":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}姐",
    "妹妹":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}妹",
    "伯父":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}伯",
    "叔叔":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}叔",
    "姑姑":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}姑",
    "舅舅":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}舅",
    "姨妈":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}姨",
    "伯母":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}伯母",
    "婶婶":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}婶",
    "舅妈":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}舅妈",
    "姨夫":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}姨夫",
    "堂哥":  lambda r: f"堂{_CN_NUMBERS.get(r, str(r))}哥",
    "堂弟":  lambda r: f"堂{_CN_NUMBERS.get(r, str(r))}弟",
    "堂姐":  lambda r: f"堂{_CN_NUMBERS.get(r, str(r))}姐",
    "堂妹":  lambda r: f"堂{_CN_NUMBERS.get(r, str(r))}妹",
    "表哥":  lambda r: f"表{_CN_NUMBERS.get(r, str(r))}哥",
    "表弟":  lambda r: f"表{_CN_NUMBERS.get(r, str(r))}弟",
    "表姐":  lambda r: f"表{_CN_NUMBERS.get(r, str(r))}姐",
    "表妹":  lambda r: f"表{_CN_NUMBERS.get(r, str(r))}妹",
    "爷爷":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}爷爷",
    "奶奶":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}奶奶",
    "外公":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}外公",
    "外婆":  lambda r: f"{_CN_NUMBERS.get(r, str(r))}外婆",
}


def _apply_rank_to_title(title: str, rank: int, total: int) -> str:
    """
    给称呼加上排行。
    rank: 从1开始（按x坐标从左到右），total: 同辈总数。
    只有 total >= 2 时才加排行。
    """
    if total < 2 or rank < 1:
        return title
    
    rule = _RANK_RULES.get(title)
    if rule:
        return rule(rank)
    
    return title


def _is_direct_lineage(signature: list) -> bool:
    """
    判断路径签名是否为纯直系链（只由 parent/child 组成，没有同辈跳转或配偶）。
    纯直系例: f,f (爷爷)、f,f,f (曾祖父)、s,s (孙子)
    非直系例: f,f,xb (爷爷的兄弟)、f,ob (伯父，经过同辈跳转)
    """
    for action, _ in signature:
        if action not in ("parent", "child"):
            return False
    return True


def infer_kinship(source_id: str, target_id: str, nodes: list, edges: list) -> dict:
    """
    推导两人之间的亲戚称谓
    
    返回:
        {
            "title": "主称呼",
            "aliases": ["别名1", "别名2"],
            "chain": "关系链编码",
            "match_type": "primary|combined|branch|fallback",
            "path_desc": "路径描述"
        }
    """
    data = get_kinship_data()
    G, node_data = _build_graph(nodes, edges)
    
    # 检查连通性
    U = G.to_undirected()
    if not nx.has_path(U, source_id, target_id):
        return {
            "title": "没有亲戚关系",
            "aliases": [],
            "chain": "",
            "match_type": "none",
            "path_desc": "两人之间没有路径连接",
        }
    
    # 找最短路径
    path = _find_path(G, source_id, target_id)
    if not path:
        return {
            "title": "无法计算称呼",
            "aliases": [],
            "chain": "",
            "match_type": "error",
            "path_desc": "",
        }
    
    # 构建路径签名
    signature = _path_to_graph_signature(G, path, node_data)
    chain = _signature_to_chain(signature, node_data.get(source_id, {}), path, node_data)
    
    # 构建可读路径描述
    step_names = {
        "f": "父", "m": "母", "s": "子", "d": "女",
        "h": "夫", "w": "妻", "xb": "兄弟", "xs": "姐妹",
        "ob": "兄", "lb": "弟", "os": "姐", "ls": "妹",
        "s&o": "子(长)", "s&l": "子(幼)", "d&o": "女(长)", "d&l": "女(幼)",
    }
    path_parts = chain.split(",")
    path_desc = " → ".join(step_names.get(p, step_names.get(p.split("&")[0], p)) for p in path_parts)
    
    print(f"\n[推导] {source_id} → {target_id}")
    print(f"[推导] 路径: {' → '.join(path)}")
    print(f"[推导] 编码链: {chain}")
    print(f"[推导] 路径描述: {path_desc}")
    
    # ===== 计算排行 =====
    # 直系亲属（纯 parent/child 链）不加排行
    # 例如 f,f = 爷爷，不管爷爷在兄弟中排第几，对"我"就是"爷爷"
    is_direct = _is_direct_lineage(signature)
    if is_direct:
        rank, total = 0, 0
    else:
        rank, total = _get_rank_among_siblings(G, node_data, target_id)
    
    # ===== 第一级：精确匹配主要关系 =====
    # 生成带长幼标记的变体
    variants = _try_with_elder_younger(chain, node_data.get(source_id, {}), node_data.get(target_id, {}))
    
    for variant in variants:
        result = data.lookup_primary(variant)
        if result:
            title = _apply_rank_to_title(result["title"], rank, total)
            print(f"[推导] ✓ 主要关系匹配: {variant} → {result['title']} → {title} (排行{rank}/{total})")
            return {
                "title": title,
                "aliases": result["aliases"],
                "chain": variant,
                "match_type": "primary",
                "path_desc": path_desc,
            }
    
    # ===== 第二级：并称关系模糊匹配 =====
    for variant in variants:
        result = data.lookup_combined(variant)
        if result:
            title = _apply_rank_to_title(result["title"], rank, total)
            print(f"[推导] ✓ 并称关系匹配: {variant} → {result['title']} → {title} (排行{rank}/{total})")
            return {
                "title": title,
                "aliases": result["aliases"],
                "chain": variant,
                "match_type": "combined",
                "path_desc": path_desc,
            }
    
    # ===== 第三级：分支关系模板匹配 =====
    for variant in variants:
        result = data.lookup_branch(variant)
        if result:
            title = _apply_rank_to_title(result["title"], rank, total)
            print(f"[推导] ✓ 分支关系匹配: {variant} → {result['title']} → {title} (排行{rank}/{total})")
            return {
                "title": title,
                "aliases": result["aliases"],
                "chain": variant,
                "match_type": "branch",
                "path_desc": path_desc,
            }
    
    # ===== Fallback：用路径描述生成可读称呼 =====
    # 把路径描述中的 " → " 拼成 "的" 连接，如 "弟 → 妻 → 父" → "弟的妻的父亲"
    fallback_title = path_desc.replace(" → ", "的") if path_desc else "远房亲戚"
    print(f"[推导] ✗ 未匹配到规则，链: {chain}，回退称呼: {fallback_title}")
    return {
        "title": fallback_title,
        "aliases": [],
        "chain": chain,
        "match_type": "fallback",
        "path_desc": path_desc,
    }
