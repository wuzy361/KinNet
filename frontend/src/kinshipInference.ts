/**
 * 亲戚称谓推导引擎 (纯前端版)
 * 基于简易有向图 + BFS 最短路径 + CSV 多级匹配
 */

import { getKinshipData, type KinshipRule } from './kinshipLoader';

// ========== 简易有向图 ==========

interface GraphEdge {
  relation: 'parent_of' | 'spouse_of';
}

class SimpleGraph {
  private adjOut = new Map<string, Map<string, GraphEdge>>(); // node -> { target -> edge }
  private adjIn  = new Map<string, Map<string, GraphEdge>>(); // node -> { source -> edge }

  addNode(id: string): void {
    if (!this.adjOut.has(id)) this.adjOut.set(id, new Map());
    if (!this.adjIn.has(id))  this.adjIn.set(id, new Map());
  }

  addEdge(source: string, target: string, relation: 'parent_of' | 'spouse_of'): void {
    this.addNode(source);
    this.addNode(target);
    this.adjOut.get(source)!.set(target, { relation });
    this.adjIn.get(target)!.set(source, { relation });
  }

  hasEdge(source: string, target: string): boolean {
    return this.adjOut.get(source)?.has(target) ?? false;
  }

  getEdgeData(source: string, target: string): GraphEdge | undefined {
    return this.adjOut.get(source)?.get(target);
  }

  /** 出边邻居 */
  successors(node: string): string[] {
    return [...(this.adjOut.get(node)?.keys() ?? [])];
  }

  /** 入边邻居 */
  predecessors(node: string): string[] {
    return [...(this.adjIn.get(node)?.keys() ?? [])];
  }

  /** 无向 BFS 最短路径 */
  shortestPath(source: string, target: string): string[] | null {
    if (source === target) return [source];
    const visited = new Set<string>([source]);
    const prev = new Map<string, string>();
    const queue = [source];
    let head = 0;

    while (head < queue.length) {
      const cur = queue[head++];
      // 出边
      for (const neighbor of (this.adjOut.get(cur)?.keys() ?? [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          prev.set(neighbor, cur);
          if (neighbor === target) return this._reconstructPath(prev, source, target);
          queue.push(neighbor);
        }
      }
      // 入边（无向）
      for (const neighbor of (this.adjIn.get(cur)?.keys() ?? [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          prev.set(neighbor, cur);
          if (neighbor === target) return this._reconstructPath(prev, source, target);
          queue.push(neighbor);
        }
      }
    }
    return null;
  }

  /** 无向连通性检测 */
  hasPath(source: string, target: string): boolean {
    return this.shortestPath(source, target) !== null;
  }

  private _reconstructPath(prev: Map<string, string>, source: string, target: string): string[] {
    const path = [target];
    let cur = target;
    while (cur !== source) {
      cur = prev.get(cur)!;
      path.unshift(cur);
    }
    return path;
  }
}

// ========== 图构建 ==========

interface NodeInput {
  id: string;
  gender?: string;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

interface EdgeInput {
  source: string;
  target: string;
  label: string;
}

function buildGraph(nodes: NodeInput[], edges: EdgeInput[]): { G: SimpleGraph; nodeData: Map<string, NodeInput> } {
  const G = new SimpleGraph();
  const nodeData = new Map<string, NodeInput>();

  for (const n of nodes) {
    nodeData.set(n.id, n);
    G.addNode(n.id);
  }

  for (const e of edges) {
    if (e.label === 'parent_of') {
      G.addEdge(e.source, e.target, 'parent_of');
    } else if (e.label === 'spouse_of') {
      G.addEdge(e.source, e.target, 'spouse_of');
      G.addEdge(e.target, e.source, 'spouse_of');
    }
  }

  return { G, nodeData };
}

// ========== 路径签名 ==========

type ActionType = 'parent' | 'child' | 'spouse';
type Signature = [ActionType, string][];

function pathToGraphSignature(G: SimpleGraph, path: string[], nodeData: Map<string, NodeInput>): Signature {
  const signature: Signature = [];
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i], v = path[i + 1];
    const vGender = nodeData.get(v)?.gender ?? 'M';

    if (G.hasEdge(v, u) && G.getEdgeData(v, u)?.relation === 'parent_of') {
      signature.push(['parent', vGender]);
    } else if (G.hasEdge(u, v) && G.getEdgeData(u, v)?.relation === 'parent_of') {
      signature.push(['child', vGender]);
    } else if (G.hasEdge(u, v) && G.getEdgeData(u, v)?.relation === 'spouse_of') {
      signature.push(['spouse', vGender]);
    }
  }
  return signature;
}

// ========== 签名→编码链 ==========

const ACTION_MAP: Record<string, string> = {
  'parent,M': 'f', 'parent,F': 'm',
  'child,M': 's', 'child,F': 'd',
  'spouse,M': 'h', 'spouse,F': 'w',
};

function signatureToChain(signature: Signature, path: string[], nodeData: Map<string, NodeInput>): string {
  const chainParts: string[] = [];
  let i = 0;
  while (i < signature.length) {
    const [action, gender] = signature[i];

    // 检测同辈关系: parent -> child 模式
    if (action === 'parent' && i + 1 < signature.length && signature[i + 1][0] === 'child') {
      const nextGender = signature[i + 1][1];

      // 比较同辈两人的 x 位置判断长幼（左大右小）
      const fromData = nodeData.get(path[i]);
      const toData = nodeData.get(path[i + 2]);
      const fromX = fromData?.position?.x ?? null;
      const toX = toData?.position?.x ?? null;

      if (fromX !== null && toX !== null && fromX !== toX) {
        if (nextGender === 'M') {
          chainParts.push(toX < fromX ? 'ob' : 'lb');
        } else {
          chainParts.push(toX < fromX ? 'os' : 'ls');
        }
      } else {
        chainParts.push(nextGender === 'M' ? 'xb' : 'xs');
      }
      i += 2;
      continue;
    }

    const code = ACTION_MAP[`${action},${gender}`];
    if (code) chainParts.push(code);
    i++;
  }

  // 处理末尾 s/d 的长幼标记
  if (chainParts.length > 0 && (chainParts[chainParts.length - 1] === 's' || chainParts[chainParts.length - 1] === 'd') && path.length >= 2) {
    const sourceData = nodeData.get(path[0]);
    const targetData = nodeData.get(path[path.length - 1]);
    const srcPos = sourceData?.position;
    const tgtPos = targetData?.position;

    if (srcPos && tgtPos) {
      const srcX = srcPos.x, srcY = srcPos.y;
      const tgtX = tgtPos.x, tgtY = tgtPos.y;

      if (srcX != null && tgtX != null && srcY != null && tgtY != null
          && Math.abs(srcY - tgtY) < 100 && srcX !== tgtX) {
        chainParts[chainParts.length - 1] += tgtX < srcX ? '&o' : '&l';
      }
    }
  }

  return chainParts.join(',');
}

// ========== 长幼变体 ==========

const VARIANTS_MAP: Record<string, string[]> = {
  'ob': ['ob', 'xb', 's&o'],
  'lb': ['lb', 'xb', 's&l'],
  'os': ['os', 'xs', 'd&o'],
  'ls': ['ls', 'xs', 'd&l'],
  'xb': ['xb', 's&o', 's&l', 'ob', 'lb'],
  'xs': ['xs', 'd&o', 'd&l', 'os', 'ls'],
};

function tryWithElderYounger(chain: string): string[] {
  const parts = chain.split(',');

  const siblingIndices = parts.reduce<number[]>((acc, p, i) => {
    if (['ob', 'lb', 'os', 'ls', 'xb', 'xs'].includes(p)) acc.push(i);
    return acc;
  }, []);

  const hasElderYoungerSuffix = parts.length > 0 && (parts[parts.length - 1].endsWith('&o') || parts[parts.length - 1].endsWith('&l'));

  if (siblingIndices.length === 0 && !hasElderYoungerSuffix) return [chain];

  function generate(idx: number, currentParts: string[]): string[] {
    if (idx >= siblingIndices.length) return [currentParts.join(',')];

    const pos = siblingIndices[idx];
    const original = parts[pos];
    const results: string[] = [];
    const seen = new Set<string>();
    for (const variant of (VARIANTS_MAP[original] ?? [original])) {
      const newParts = [...currentParts];
      newParts[pos] = variant;
      for (const r of generate(idx + 1, newParts)) {
        if (!seen.has(r)) { seen.add(r); results.push(r); }
      }
    }
    return results;
  }

  const baseVariants = siblingIndices.length > 0 ? generate(0, [...parts]) : [chain];

  const allVariants: string[] = [];
  const seen = new Set<string>();

  for (const v of baseVariants) {
    if (!seen.has(v)) { seen.add(v); allVariants.push(v); }
    const vParts = v.split(',');
    if (vParts[vParts.length - 1].endsWith('&o') || vParts[vParts.length - 1].endsWith('&l')) {
      const stripped = [...vParts];
      stripped[stripped.length - 1] = stripped[stripped.length - 1].split('&')[0];
      const s = stripped.join(',');
      if (!seen.has(s)) { seen.add(s); allVariants.push(s); }
    }
  }

  // 确保原始链排在第一位
  const idx = allVariants.indexOf(chain);
  if (idx > 0) {
    allVariants.splice(idx, 1);
    allVariants.unshift(chain);
  }
  return allVariants;
}

// ========== 排行计算 ==========

function getDirectRank(G: SimpleGraph, nodeData: Map<string, NodeInput>, targetId: string): [number, number] {
  const target = nodeData.get(targetId);
  if (!target) return [0, 0];

  const targetGender = target.gender ?? 'M';
  const parents: string[] = [];
  for (const pred of G.predecessors(targetId)) {
    if (G.getEdgeData(pred, targetId)?.relation === 'parent_of') {
      parents.push(pred);
    }
  }
  if (parents.length === 0) return [0, 0];

  const siblings = new Set<string>();
  for (const parentId of parents) {
    for (const childId of G.successors(parentId)) {
      if (G.getEdgeData(parentId, childId)?.relation === 'parent_of') {
        const child = nodeData.get(childId);
        if (child && child.gender === targetGender) siblings.add(childId);
      }
    }
  }

  if (siblings.size <= 1) return [0, 0];

  const getX = (nid: string) => nodeData.get(nid)?.position?.x ?? 0;
  const sorted = [...siblings].sort((a, b) => getX(a) - getX(b));
  const rank = sorted.indexOf(targetId) + 1;
  return rank > 0 ? [rank, sorted.length] : [0, 0];
}

function getRankAmongSiblings(G: SimpleGraph, nodeData: Map<string, NodeInput>, targetId: string): [number, number] {
  let [rank, total] = getDirectRank(G, nodeData, targetId);
  if (total >= 2) return [rank, total];

  // 回退：找配偶的排行
  for (const neighbor of G.successors(targetId)) {
    if (G.getEdgeData(targetId, neighbor)?.relation === 'spouse_of') {
      [rank, total] = getDirectRank(G, nodeData, neighbor);
      if (total >= 2) return [rank, total];
    }
  }
  for (const neighbor of G.predecessors(targetId)) {
    if (G.getEdgeData(neighbor, targetId)?.relation === 'spouse_of') {
      [rank, total] = getDirectRank(G, nodeData, neighbor);
      if (total >= 2) return [rank, total];
    }
  }
  return [0, 0];
}

// ========== 排行应用（已禁用） ==========

function applyRankToTitle(title: string, _rank: number, _total: number): string {
  return title;
}

function isDirectLineage(signature: Signature): boolean {
  return signature.every(([action]) => action === 'parent' || action === 'child');
}

// ========== 路径描述 ==========

const STEP_NAMES: Record<string, string> = {
  'f': '父', 'm': '母', 's': '子', 'd': '女',
  'h': '夫', 'w': '妻', 'xb': '兄弟', 'xs': '姐妹',
  'ob': '兄', 'lb': '弟', 'os': '姐', 'ls': '妹',
  's&o': '子', 's&l': '子', 'd&o': '女', 'd&l': '女',
};

function buildPathDesc(chain: string): string {
  const parts = chain.split(',');
  return parts.map(p => STEP_NAMES[p] ?? STEP_NAMES[p.split('&')[0]] ?? p).join(' → ');
}

// ========== 主推导函数 ==========

export interface InferResult {
  title: string;
  aliases: string[];
  chain: string;
  match_type: string;
  path_desc: string;
}

export async function inferKinship(
  sourceId: string,
  targetId: string,
  nodes: NodeInput[],
  edges: EdgeInput[]
): Promise<InferResult> {
  const data = await getKinshipData();
  const { G, nodeData } = buildGraph(nodes, edges);

  // 检查连通性
  if (!G.hasPath(sourceId, targetId)) {
    return { title: '没有亲戚关系', aliases: [], chain: '', match_type: 'none', path_desc: '两人之间没有路径连接' };
  }

  // 找最短路径
  const path = G.shortestPath(sourceId, targetId);
  if (!path) {
    return { title: '无法计算称呼', aliases: [], chain: '', match_type: 'error', path_desc: '' };
  }

  // 构建路径签名
  const signature = pathToGraphSignature(G, path, nodeData);
  const chain = signatureToChain(signature, path, nodeData);
  const pathDesc = buildPathDesc(chain);

  // 计算排行
  const isDirect = isDirectLineage(signature);
  const [rank, total] = isDirect ? [0, 0] : getRankAmongSiblings(G, nodeData, targetId);

  // 生成长幼变体
  const variants = tryWithElderYounger(chain);

  // 第一级：精确匹配主要关系
  for (const variant of variants) {
    const result = data.lookupPrimary(variant);
    if (result) {
      return makeResult(result, variant, rank, total, pathDesc, 'primary');
    }
  }

  // 第二级：并称关系模糊匹配
  for (const variant of variants) {
    const result = data.lookupCombined(variant);
    if (result) {
      return makeResult(result, variant, rank, total, pathDesc, 'combined');
    }
  }

  // 第三级：分支关系模板匹配
  for (const variant of variants) {
    const result = data.lookupBranch(variant);
    if (result) {
      return makeResult(result, variant, rank, total, pathDesc, 'branch');
    }
  }

  // Fallback
  return { title: '远房亲戚', aliases: [], chain, match_type: 'fallback', path_desc: pathDesc };
}

function makeResult(rule: KinshipRule, chain: string, rank: number, total: number, pathDesc: string, matchType: string): InferResult {
  return {
    title: applyRankToTitle(rule.title, rank, total),
    aliases: rule.aliases,
    chain,
    match_type: matchType,
    path_desc: pathDesc,
  };
}
