import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
} from '@xyflow/react';
import type { NodeChange, EdgeChange, Node, Edge, Connection, Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng } from 'html-to-image';
import { HelpCircle, Download, Link } from 'lucide-react';
import { PersonNode } from './PersonNode';
import { inferKinship } from './kinshipInference';

const nodeTypes = {
  person: PersonNode,
};

const initialNodes: Node[] = [
  {
    id: 'me',
    type: 'person',
    position: { x: 420, y: 420 },
    data: { name: '我 (Self)', role: '起点', gender: 'M', isMe: true },
  },
  {
    id: 'father',
    type: 'person',
    position: { x: 420, y: 210 },
    data: { name: '父亲', role: '父亲', gender: 'M' },
  },
  {
    id: 'mother',
    type: 'person',
    position: { x: 630, y: 210 },
    data: { name: '母亲', role: '母亲', gender: 'F' },
  }
];

const initialEdges: Edge[] = [
  {
    id: 'e-father-me',
    source: 'father',
    sourceHandle: 'child',
    target: 'me',
    targetHandle: 'parent',
    animated: true,
    style: { stroke: '#34d399', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' },
  },
  {
    id: 'e-mother-me',
    source: 'mother',
    sourceHandle: 'child',
    target: 'me',
    targetHandle: 'parent',
    animated: true,
    style: { stroke: '#34d399', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' },
  },
  {
    id: 'e-father-mother',
    source: 'father',
    sourceHandle: 'spouse-r',
    target: 'mother',
    targetHandle: 'spouse-l',
    animated: false,
    style: { stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '5 5' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#f472b6' },
  }
];

interface NodeDetail {
  title: string;
  aliases: string[];
  chain: string;
  path_desc: string;
  match_type: string;
  gender: string;
}

function AppInner() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const [selectedDetail, setSelectedDetail] = useState<NodeDetail | null>(null);
  const selectedDetailRef = useRef<string | null>(null); // 当前选中节点 id
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const reactFlowInstance = useReactFlow();

  const GRID = 210;

  // 记录拖拽开始前每个节点的位置
  const dragStartPositions = useRef<Record<string, { x: number; y: number }>>({});
  // 用 ref 让 onNodesChange 能访问最新的 edges
  const edgesRef = useRef<Edge[]>(edges);
  edgesRef.current = edges;
  // 用 ref 让 onConnect 能访问最新的 nodes
  const nodesRef = useRef<Node[]>(nodes);
  nodesRef.current = nodes;

  // 重新计算所有非"我"节点的称呼
  const recalculateAllNames = useCallback(async () => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const meNode = currentNodes.find(n => n.data.isMe);
    if (!meNode) return;

    const otherNodes = currentNodes.filter(n => !n.data.isMe);
    if (otherNodes.length === 0) return;

    const nodesPayload = currentNodes.map(n => ({ id: n.id, ...n.data, position: n.position }));
    const edgesPayload = currentEdges.map(e => ({
      source: e.source,
      target: e.target,
      label: e.sourceHandle?.startsWith('spouse') ? 'spouse_of' : 'parent_of'
    }));

    const results = await Promise.allSettled(
      otherNodes.map(n =>
        inferKinship(meNode.id, n.id, nodesPayload, edgesPayload)
      )
    );

    setNodes(nds => nds.map(n => {
      if (n.data.isMe) return n;
      const idx = otherNodes.findIndex(o => o.id === n.id);
      if (idx === -1) return n;
      const res = results[idx];
      if (res.status === 'fulfilled') {
        const newName = res.value.title || "未知亲戚";
        const newRole = res.value.path_desc || '';
        if (n.data.name !== newName || n.data.role !== newRole) {
          return { ...n, data: { ...n.data, name: newName, role: newRole } };
        }
      }
      return n;
    }));
  }, [setNodes]);

  // 标记拖拽后位置是否发生了变化，需要重算称呼
  const needRecalcRef = useRef(false);

  // 当 nodes/edges 更新后（渲染完成后），检查是否需要重算称呼
  useEffect(() => {
    if (needRecalcRef.current) {
      needRecalcRef.current = false;
      recalculateAllNames();
    }
  }, [nodes, edges, recalculateAllNames]);

  // 节点选中时查询详情
  const fetchSelectedDetail = useCallback(async (nodeId: string) => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const meNode = currentNodes.find(n => n.data.isMe);
    const targetNode = currentNodes.find(n => n.id === nodeId);
    if (!meNode || !targetNode) return;

    if (targetNode.data.isMe) {
      setSelectedDetail({
        title: '我 (Self)',
        aliases: ['自己', '我', '俺', '吾', '本人', '在下'],
        chain: '',
        path_desc: '起点',
        match_type: 'self',
        gender: targetNode.data.gender as string,
      });
      return;
    }

    const nodesPayload = currentNodes.map(n => ({ id: n.id, ...n.data, position: n.position }));
    const edgesPayload = currentEdges.map(e => ({
      source: e.source,
      target: e.target,
      label: e.sourceHandle?.startsWith('spouse') ? 'spouse_of' : 'parent_of'
    }));

    try {
      const res = await inferKinship(meNode.id, nodeId, nodesPayload, edgesPayload);
      if (selectedDetailRef.current === nodeId) {
        setSelectedDetail({
          ...res,
          gender: targetNode.data.gender as string,
        });
      }
    } catch {
      setSelectedDetail(null);
    }
  }, []);

  const onSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Node[] }) => {
    if (selectedNodes.length !== 1) {
      selectedDetailRef.current = null;
      setSelectedDetail(null);
    }
  }, []);

  // 点击节点：已选中状态下再点一次展开详情
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    if (node.selected) {
      // 已经选中的节点再次点击 → 展开详情
      selectedDetailRef.current = node.id;
      fetchSelectedDetail(node.id);
    }
  }, [fetchSelectedDetail]);

  // 拖拽开始时记录位置
  const onNodeDragStart = useCallback((_event: React.MouseEvent, node: Node) => {
    dragStartPositions.current[node.id] = { ...node.position };
  }, []);

  // ---- 辅助：获取节点的配偶 ID ----
  const getSpouseId = useCallback((nodeId: string, edgeList: Edge[]): string | null => {
    for (const e of edgeList) {
      if (e.sourceHandle?.startsWith('spouse')) {
        if (e.source === nodeId) return e.target;
        if (e.target === nodeId) return e.source;
      }
    }
    return null;
  }, []);

  // ---- 辅助：构建同行的"夫妻组"列表，按 x 排序 ----
  // 每个组 = { left: x, ids: [id, ...], right: x }，夫妻算一个组，单身算一个组
  const buildRowGroups = useCallback((rowNodes: Node[], edgeList: Edge[]) => {
    const visited = new Set<string>();
    const groups: { ids: string[]; leftX: number; rightX: number }[] = [];

    for (const n of rowNodes) {
      if (visited.has(n.id)) continue;
      visited.add(n.id);
      const spouseId = getSpouseId(n.id, edgeList);
      const spouseNode = spouseId ? rowNodes.find(rn => rn.id === spouseId) : null;
      if (spouseNode && !visited.has(spouseNode.id)) {
        visited.add(spouseNode.id);
        const minX = Math.min(n.position.x, spouseNode.position.x);
        const maxX = Math.max(n.position.x, spouseNode.position.x);
        groups.push({ ids: [n.id, spouseNode.id], leftX: minX, rightX: maxX });
      } else {
        groups.push({ ids: [n.id], leftX: n.position.x, rightX: n.position.x });
      }
    }
    groups.sort((a, b) => a.leftX - b.leftX);
    return groups;
  }, [getSpouseId]);

  // 拖拽结束时：吸附网格、检查约束、同行挤开、触发重算
  const onNodeDragStop = useCallback((_event: React.MouseEvent, node: Node) => {
    const prev = dragStartPositions.current[node.id];
    delete dragStartPositions.current[node.id];

    setNodes(nds => {
      const idx = nds.findIndex(n => n.id === node.id);
      if (idx === -1) return nds;

      const snappedX = Math.round(node.position.x / GRID) * GRID;
      const snappedY = Math.round(node.position.y / GRID) * GRID;
      const currentEdges = edgesRef.current;

      // 检查父子层级约束
      let violatesLevel = false;
      for (const edge of currentEdges) {
        if (edge.sourceHandle?.startsWith('spouse')) {
          // 配偶必须同层
          const spouseId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
          if (spouseId) {
            const spouseNode = nds.find(n => n.id === spouseId);
            if (spouseNode && Math.round(spouseNode.position.y) !== snappedY) {
              violatesLevel = true;
              break;
            }
          }
          continue;
        }
        if (edge.source === node.id) {
          const childNode = nds.find(n => n.id === edge.target);
          if (childNode && Math.round(childNode.position.y) !== snappedY + GRID) {
            violatesLevel = true;
            break;
          }
        }
        if (edge.target === node.id) {
          const parentNode = nds.find(n => n.id === edge.source);
          if (parentNode && Math.round(parentNode.position.y) !== snappedY - GRID) {
            violatesLevel = true;
            break;
          }
        }
      }

      // 违反层级 → 弹回
      if (violatesLevel) {
        if (prev) {
          const result = [...nds];
          result[idx] = { ...result[idx], position: { x: prev.x, y: prev.y } };
          return result;
        }
        return nds;
      }

      const sameRow = prev && Math.round(prev.y) === snappedY;

      // 跨行拖拽：不做挤开，只做简单占位检查
      if (!sameRow) {
        const isOccupied = nds.some((n, i) => i !== idx && Math.abs(n.position.x - snappedX) < 10 && Math.abs(n.position.y - snappedY) < 10);
        if (isOccupied) {
          if (prev) {
            const result = [...nds];
            result[idx] = { ...result[idx], position: { x: prev.x, y: prev.y } };
            return result;
          }
          return nds;
        }
        const result = [...nds];
        result[idx] = { ...result[idx], position: { x: snappedX, y: snappedY } };
        if (prev && (prev.x !== snappedX || prev.y !== snappedY)) {
          needRecalcRef.current = true;
        }
        return result;
      }

      // 同行逻辑：先放到目标格，再处理挤开
      let result = [...nds];
      result[idx] = { ...result[idx], position: { x: snappedX, y: snappedY } };

      // 拖拽节点的配偶也要跟着（保持夫妻相邻，丈夫左妻子右）
      const draggedSpouseId = getSpouseId(node.id, currentEdges);
      if (draggedSpouseId) {
        const spIdx = result.findIndex(n => n.id === draggedSpouseId);
        if (spIdx !== -1) {
          const draggedNode = result[idx];
          const spouseNode = result[spIdx];
          const draggedGender = draggedNode.data.gender as string;
          // 丈夫在左，妻子在右
          if (draggedGender === 'M') {
            // 拖拽的是丈夫，配偶（妻子）在右边
            result[spIdx] = { ...spouseNode, position: { x: snappedX + GRID, y: snappedY } };
          } else {
            // 拖拽的是妻子，配偶（丈夫）在左边
            result[spIdx] = { ...spouseNode, position: { x: snappedX - GRID, y: snappedY } };
          }
        }
      }

      // 收集拖拽组的所有 id（包含配偶）
      const draggedIds = new Set<string>([node.id]);
      if (draggedSpouseId) draggedIds.add(draggedSpouseId);

      // 同行其他节点：检测冲突并挤开
      const rowY = snappedY;
      const sameRowOthers = result.filter(n => !draggedIds.has(n.id) && Math.abs(Math.round(n.position.y) - rowY) < 10);

      if (sameRowOthers.length > 0) {
        // 构建同行组（不含拖拽组）
        const groups = buildRowGroups(sameRowOthers, currentEdges);
        // 拖拽组占据的 x 范围
        const draggedXs = [...draggedIds].map(did => result.find(n => n.id === did)!.position.x);
        const dragLeft = Math.min(...draggedXs);
        const dragRight = Math.max(...draggedXs);

        // 检查每个组是否与拖拽组冲突
        for (const group of groups) {
          const conflictsWithDragged = group.ids.some(gid => {
            const gNode = result.find(n => n.id === gid)!;
            return draggedXs.some(dx => Math.abs(gNode.position.x - dx) < GRID * 0.5);
          });

          if (conflictsWithDragged) {
            // 决定推向哪边：组中心在拖拽组中心的左边就推左，否则推右
            const groupCenterX = (group.leftX + group.rightX) / 2;
            const dragCenterX = (dragLeft + dragRight) / 2;
            const pushRight = groupCenterX >= dragCenterX;

            // 推这个组的所有节点
            for (const gid of group.ids) {
              const gIdx = result.findIndex(n => n.id === gid);
              if (gIdx === -1) continue;
              let targetX = result[gIdx].position.x;

              if (pushRight) {
                // 推到 dragRight + GRID 或更右
                const minAllowed = dragRight + GRID;
                if (targetX < minAllowed) targetX = minAllowed;
              } else {
                // 推到 dragLeft - GRID 或更左
                const maxAllowed = dragLeft - GRID;
                if (targetX > maxAllowed) targetX = maxAllowed;
              }
              result[gIdx] = { ...result[gIdx], position: { x: targetX, y: rowY } };
            }

            // 推完后需要保证同一组内夫妻仍相邻且丈夫在左
            if (group.ids.length === 2) {
              const [id1, id2] = group.ids;
              const n1 = result.find(n => n.id === id1)!;
              const n2 = result.find(n => n.id === id2)!;
              const n1Idx = result.findIndex(n => n.id === id1);
              const n2Idx = result.findIndex(n => n.id === id2);
              const husband = n1.data.gender === 'M' ? n1 : n2;
              const wife = n1.data.gender === 'M' ? n2 : n1;
              const hIdx = n1.data.gender === 'M' ? n1Idx : n2Idx;
              const wIdx = n1.data.gender === 'M' ? n2Idx : n1Idx;
              if (pushRight) {
                const baseX = Math.max(husband.position.x, wife.position.x - GRID);
                result[hIdx] = { ...result[hIdx], position: { x: baseX, y: rowY } };
                result[wIdx] = { ...result[wIdx], position: { x: baseX + GRID, y: rowY } };
              } else {
                const baseX = Math.min(wife.position.x, husband.position.x + GRID);
                result[wIdx] = { ...result[wIdx], position: { x: baseX, y: rowY } };
                result[hIdx] = { ...result[hIdx], position: { x: baseX - GRID, y: rowY } };
              }
            }
          }
        }

        // 递归解决被推开的组之间的新冲突
        let maxIter = 20;
        let hasConflict = true;
        while (hasConflict && maxIter-- > 0) {
          hasConflict = false;
          const allRowNodes = result.filter(n => Math.abs(Math.round(n.position.y) - rowY) < 10);
          const allGroups = buildRowGroups(allRowNodes, currentEdges);
          for (let i = 0; i < allGroups.length - 1; i++) {
            const curr = allGroups[i];
            const next = allGroups[i + 1];
            if (next.leftX - curr.rightX < GRID - 5) {
              // 冲突：把后面的组推右
              const shift = curr.rightX + GRID - next.leftX;
              for (const gid of next.ids) {
                const gIdx = result.findIndex(n => n.id === gid);
                if (gIdx !== -1) {
                  result[gIdx] = { ...result[gIdx], position: { x: result[gIdx].position.x + shift, y: rowY } };
                }
              }
              hasConflict = true;
            }
          }
        }
      }

      // 位置确实发生了变化
      if (prev && (prev.x !== snappedX || prev.y !== snappedY)) {
        needRecalcRef.current = true;
      }
      return result;
    });
  }, [setNodes, getSpouseId, buildRowGroups]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    []
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
      if (changes.some(c => c.type === 'remove')) {
        needRecalcRef.current = true;
      }
    },
    []
  );

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => {
      let edgeStyle: React.CSSProperties = { stroke: '#818cf8', strokeWidth: 2 };
      let edgeColor = '#818cf8';
      let animated = true;

      if (params.sourceHandle === 'child' && params.targetHandle === 'parent') {
        // 校验层级：父节点(source)必须在子节点(target)的上一层
        const sourceNode = nodesRef.current.find(n => n.id === params.source);
        const targetNode = nodesRef.current.find(n => n.id === params.target);
        if (sourceNode && targetNode) {
          const parentY = Math.round(sourceNode.position.y);
          const childY = Math.round(targetNode.position.y);
          if (childY !== parentY + GRID) {
            alert("父子关系连线无效！子节点必须在父节点的下一层方格中。");
            return eds;
          }
        }
        edgeStyle = { stroke: '#34d399', strokeWidth: 2 };
        edgeColor = '#34d399';
      } else if (params.sourceHandle?.startsWith('spouse') && params.targetHandle?.startsWith('spouse')) {
        const sourceNode = nodesRef.current.find(n => n.id === params.source);
        const targetNode = nodesRef.current.find(n => n.id === params.target);
        if (!sourceNode || !targetNode || !params.source || !params.target) {
          return eds;
        }
        // 1. 异性检查
        if (sourceNode.data.gender === targetNode.data.gender) {
          alert("配偶连线无效！配偶必须是异性。");
          return eds;
        }
        // 2. 同行检查
        if (Math.round(sourceNode.position.y) !== Math.round(targetNode.position.y)) {
          alert("配偶连线无效！配偶必须在同一行。");
          return eds;
        }
        // 3. 单配偶检查
        const hasSpouseEdge = (nid: string) => eds.some(e =>
          (e.source === nid && e.sourceHandle?.startsWith('spouse')) ||
          (e.target === nid && e.targetHandle?.startsWith('spouse'))
        );
        if (hasSpouseEdge(params.source) || hasSpouseEdge(params.target)) {
          alert("每个人最多只能有一段婚姻关系！");
          return eds;
        }
        // 4. 亲缘关系检查 — 通过 parent_of 边 BFS，任何可达的血亲都不能配对
        const getBloodRelativesFromEdges = (startId: string): Set<string> => {
          const visited = new Set<string>();
          const queue = [startId];
          while (queue.length > 0) {
            const cur = queue.pop()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const e of eds) {
              if (e.sourceHandle === 'child' && e.targetHandle === 'parent') {
                if (e.source === cur && !visited.has(e.target)) queue.push(e.target); // cur 的子女
                if (e.target === cur && !visited.has(e.source)) queue.push(e.source); // cur 的父母
              }
            }
          }
          return visited;
        };
        if (getBloodRelativesFromEdges(params.source).has(params.target)) {
          alert("配偶连线无效！不能和有血缘关系的亲属建立配偶关系。");
          return eds;
        }
        edgeStyle = { stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '5 5' };
        edgeColor = '#f472b6';
        animated = false;
      } else {
        alert("无效连线！只能从父辈[底部]连向子女[顶部]，或者在平级间[左右侧]连线。");
        return eds;
      }

      const edge = {
        ...params,
        animated,
        style: edgeStyle,
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor }
      };
      needRecalcRef.current = true;
      return addEdge(edge, eds);
    }),
    []
  );

  // ===== 随机生成家谱图 =====
  const [randomNodeCount, setRandomNodeCount] = useState<number>(10);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showHelp, setShowHelp] = useState(() => {
    return !localStorage.getItem('kinnet_help_seen');
  });

  // 导出图片
  const exportImage = useCallback(() => {
    const nodesBounds = getNodesBounds(nodes);
    const padding = 80;
    const imageWidth = nodesBounds.width + padding * 2;
    const imageHeight = nodesBounds.height + padding * 2;
    const viewport = getViewportForBounds(nodesBounds, imageWidth, imageHeight, 0.5, 2, padding);

    const el = document.querySelector('.react-flow__viewport') as HTMLElement;
    if (!el) return;

    toPng(el, {
      backgroundColor: '#0a0c15',
      width: imageWidth,
      height: imageHeight,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    }).then((dataUrl) => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `KinNet-${Date.now()}.png`;
      a.click();
    }).catch((err) => {
      console.error('导出图片失败', err);
    });
  }, [nodes]);

  const generateRandomGraph = useCallback(async () => {
    const targetCount = randomNodeCount;
    if (targetCount < 1 || targetCount > 200) {
      alert('节点数量请在 1~200 之间');
      return;
    }
    setIsGenerating(true);

    const GRID = 210;
    let idCounter = 0;
    const newId = () => `rnd-${Date.now()}-${idCounter++}`;

    // ── 内部 Person 模型 ──
    // 用结构化对象维护家谱，避免通过边反复查询
    interface Person {
      id: string;
      gender: 'M' | 'F';
      father: Person | null;   // 父亲
      mother: Person | null;   // 母亲
      spouse: Person | null;   // 配偶
      children: Person[];      // 子女
      isMe?: boolean;
      row: number;             // y 层级 (0 = "我", -1 = 父辈, 1 = 子辈)
      col: number;             // x 位置
    }

    const people: Person[] = [];
    const randomGender = (): 'M' | 'F' => Math.random() < 0.5 ? 'M' : 'F';
    const oppositeGender = (g: 'M' | 'F'): 'M' | 'F' => g === 'M' ? 'F' : 'M';

    // 获取兄弟姐妹（共享至少一个父母）
    const getSiblings = (person: Person): Person[] => {
      const sibs = new Set<Person>();
      const parents = [person.father, person.mother].filter(Boolean) as Person[];
      for (const p of parents) {
        for (const c of p.children) {
          if (c.id !== person.id) sibs.add(c);
        }
      }
      return [...sibs];
    };

    // 判断是否可以成为配偶（保留供将来扩展使用）

    // 创建"我"
    const mePerson: Person = {
      id: newId(), gender: randomGender(),
      father: null, mother: null, spouse: null, children: [],
      isMe: true, row: 0, col: 0,
    };
    people.push(mePerson);

    // ── 操作定义 ──
    type Action = () => void;

    const getActions = (): Action[] => {
      const actions: Action[] = [];

      for (const person of [...people]) {
        const parentCount = (person.father ? 1 : 0) + (person.mother ? 1 : 0);

        // 操作 1: 添加父亲 (没有父亲时)
        if (!person.father) {
          actions.push(() => {
            const dad: Person = {
              id: newId(), gender: 'M',
              father: null, mother: null, spouse: null, children: [person],
              row: person.row - 1, col: person.col,
            };
            person.father = dad;
            people.push(dad);
            // 如果已有母亲且母亲无配偶，自动配对，并共享母亲的所有子女
            if (person.mother && !person.mother.spouse) {
              dad.spouse = person.mother;
              person.mother.spouse = dad;
              // 母亲的所有子女也应该以 dad 为父亲
              for (const child of person.mother.children) {
                if (!child.father) {
                  child.father = dad;
                  if (!dad.children.includes(child)) dad.children.push(child);
                }
              }
            }
          });
        }

        // 操作 2: 添加母亲 (没有母亲时)
        if (!person.mother) {
          actions.push(() => {
            const mom: Person = {
              id: newId(), gender: 'F',
              father: null, mother: null, spouse: null, children: [person],
              row: person.row - 1, col: person.col + 1,
            };
            person.mother = mom;
            people.push(mom);
            // 如果已有父亲且父亲无配偶，自动配对，并共享父亲的所有子女
            if (person.father && !person.father.spouse) {
              mom.spouse = person.father;
              person.father.spouse = mom;
              // 父亲的所有子女也应该以 mom 为母亲
              for (const child of person.father.children) {
                if (!child.mother) {
                  child.mother = mom;
                  if (!mom.children.includes(child)) mom.children.push(child);
                }
              }
            }
          });
        }

        // 操作 3: 添加配偶 (配偶总是新人，不是图中已有的人)
        if (!person.spouse) {
          actions.push(() => {
            const sp: Person = {
              id: newId(), gender: oppositeGender(person.gender),
              father: null, mother: null, spouse: person, children: [],
              row: person.row, col: person.gender === 'M' ? person.col + 1 : person.col - 1,
            };
            person.spouse = sp;
            // 配偶共享已有的子女
            for (const child of person.children) {
              sp.children.push(child);
              if (sp.gender === 'M') child.father = sp;
              else child.mother = sp;
            }
            people.push(sp);
          });
        }

        // 操作 4: 添加子女 (必须已有配偶，限制子女不超过4个)
        if (person.spouse && person.gender === 'M' && person.children.length < 4) {
          actions.push(() => {
            const childGender = randomGender();
            const child: Person = {
              id: newId(), gender: childGender,
              father: person, mother: person.spouse!,
              spouse: null, children: [],
              row: person.row + 1, col: person.col + person.children.length,
            };
            person.children.push(child);
            person.spouse!.children.push(child);
            people.push(child);
          });
        }

        // 操作 5: 添加兄弟姐妹 (必须有至少一个父母，限制同辈不超过5个)
        if (parentCount >= 1) {
          const sibs = getSiblings(person);
          if (sibs.length + 1 < 5) {
            actions.push(() => {
              const sibGender = randomGender();
              // 确保兄弟姐妹共享完整的父母（包括配偶关系）
              const father = person.father ?? (person.mother?.spouse ?? null);
              const mother = person.mother ?? (person.father?.spouse ?? null);
              const sib: Person = {
                id: newId(), gender: sibGender,
                father, mother,
                spouse: null, children: [],
                row: person.row, col: person.col + sibs.length + 1,
              };
              if (father) father.children.push(sib);
              if (mother) mother.children.push(sib);
              people.push(sib);
            });
          }
        }
      }

      return actions;
    };

    // ── 生成循环 ──
    while (people.length < targetCount) {
      const actions = getActions();
      if (actions.length === 0) break;
      const chosen = actions[Math.floor(Math.random() * actions.length)];
      chosen();
    }

    // ── 转换为 React Flow 节点和边 ──
    const makeParentEdge = (parentId: string, childId: string): Edge => ({
      id: `e-${parentId}-${childId}`,
      source: parentId, sourceHandle: 'child',
      target: childId, targetHandle: 'parent',
      animated: true,
      style: { stroke: '#34d399', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' },
    });
    const makeSpouseEdge = (aId: string, bId: string): Edge => ({
      id: `e-${aId}-${bId}-sp`,
      source: aId, sourceHandle: 'spouse-r',
      target: bId, targetHandle: 'spouse-l',
      animated: false,
      style: { stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '5 5' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#f472b6' },
    });

    // ── 布局：按行分组，夫妻作为整体排列，避免配偶被拆开 ──
    const rowMap = new Map<number, Person[]>();
    for (const p of people) {
      if (!rowMap.has(p.row)) rowMap.set(p.row, []);
      rowMap.get(p.row)!.push(p);
    }

    const posResult = new Map<string, { x: number; y: number }>();

    for (const [row, rowPeople] of rowMap) {
      const y = row * GRID;
      const visited = new Set<string>();
      // 构建"单元"：夫妻合并为 [husband, wife]，单身为 [person]
      const units: Person[][] = [];
      const sorted = [...rowPeople].sort((a, b) => a.col - b.col);

      for (const p of sorted) {
        if (visited.has(p.id)) continue;
        visited.add(p.id);
        if (p.spouse && rowPeople.some(rp => rp.id === p.spouse!.id) && !visited.has(p.spouse.id)) {
          visited.add(p.spouse.id);
          if (p.gender === 'M') {
            units.push([p, p.spouse]);
          } else {
            units.push([p.spouse, p]);
          }
        } else {
          units.push([p]);
        }
      }

      // 给每个单元分配一个排序 key（单元内最小 col）
      units.sort((a, b) => {
        const aCol = Math.min(...a.map(p => p.col));
        const bCol = Math.min(...b.map(p => p.col));
        return aCol - bCol;
      });

      // 紧凑排列：逐单元分配不冲突的列位置
      let nextCol = units.length > 0 ? Math.min(...units[0].map(p => p.col)) : 0;
      for (const unit of units) {
        // 单元理想起始 col
        const idealCol = Math.min(...unit.map(p => p.col));
        // 实际起始 col 不能早于 nextCol
        const startCol = Math.max(idealCol, nextCol);
        for (let i = 0; i < unit.length; i++) {
          posResult.set(unit[i].id, { x: (startCol + i) * GRID, y });
        }
        nextCol = startCol + unit.length;
      }
    }

    const allNodes: Node[] = people.map(p => ({
      id: p.id,
      type: 'person' as const,
      position: posResult.get(p.id) || { x: p.col * GRID, y: p.row * GRID },
      data: {
        name: p.isMe ? '我 (Self)' : (p.gender === 'M' ? '男' : '女'),
        role: p.isMe ? '起点' : '',
        gender: p.gender,
        isMe: p.isMe || false,
      },
    }));

    // 生成边（去重）
    const allEdges: Edge[] = [];
    const edgeSet = new Set<string>();
    const addEdgeOnce = (e: Edge) => {
      if (!edgeSet.has(e.id)) { edgeSet.add(e.id); allEdges.push(e); }
    };
    for (const p of people) {
      if (p.father) addEdgeOnce(makeParentEdge(p.father.id, p.id));
      if (p.mother) addEdgeOnce(makeParentEdge(p.mother.id, p.id));
      if (p.spouse && p.gender === 'M') {
        addEdgeOnce(makeSpouseEdge(p.id, p.spouse.id));
      } else if (p.spouse && p.gender === 'F' && p.spouse.gender === 'M') {
        addEdgeOnce(makeSpouseEdge(p.spouse.id, p.id));
      }
    }

    // 设置到画布
    setNodes(allNodes);
    setEdges(allEdges);

    // 调用后端计算所有称谓
    const meNode = allNodes.find(n => n.data.isMe);
    if (meNode) {
      const nodesPayload = allNodes.map(n => ({ id: n.id, ...n.data, position: n.position }));
      const edgesPayload = allEdges.map(e => ({
        source: e.source,
        target: e.target,
        label: e.sourceHandle?.startsWith('spouse') ? 'spouse_of' : 'parent_of'
      }));

      const otherNodes = allNodes.filter(n => !n.data.isMe);
      const results = await Promise.allSettled(
        otherNodes.map(n =>
          inferKinship(meNode.id, n.id, nodesPayload, edgesPayload)
        )
      );

      setNodes(nds => nds.map(n => {
        if (n.data.isMe) return n;
        const idx = otherNodes.findIndex(o => o.id === n.id);
        if (idx === -1) return n;
        const res = results[idx];
        if (res.status === 'fulfilled') {
          const title = res.value.title || '未知亲戚';
          const role = res.value.path_desc || '';
          return { ...n, data: { ...n.data, name: title, role } };
        }
        return n;
      }));
    }

    setIsGenerating(false);
  }, [randomNodeCount, setNodes, setEdges]);

  const setAsMe = async () => {
    const selectedNode = nodes.find(n => n.selected);
    if (!selectedNode) {
      alert("请先在画布上选中一个节点！");
      return;
    }
    if (selectedNode.data.isMe) return; // 已经是"我"了

    // 先更新 isMe 标记：选中节点设为"我"，原"我"节点取消
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        isMe: n.id === selectedNode.id,
        name: n.id === selectedNode.id ? '我 (Self)' : n.data.name,
        role: n.id === selectedNode.id ? '起点' : n.data.role,
      }
    })));

    // 标记需要重算所有称呼
    needRecalcRef.current = true;
  };

  // ===== 辈分标签计算 =====
  const generationLabels = useMemo(() => {
    const meNode = nodes.find(n => n.data.isMe);
    if (!meNode) return [];

    const meRow = Math.round(meNode.position.y / GRID);
    const rowSet = new Set<number>();
    for (const n of nodes) {
      rowSet.add(Math.round(n.position.y / GRID));
    }
    const rows = [...rowSet].sort((a, b) => a - b);

    const GEN_NAMES: Record<number, string> = {
      '-5': '高祖辈', '-4': '曾祖辈', '-3': '祖辈',
      '-2': '父祖辈', '-1': '父辈', 0: '同辈（我）',
      1: '子辈', 2: '孙辈', 3: '曾孙辈',
      4: '玄孙辈', 5: '来孙辈',
    };

    return rows.map(row => {
      const diff = row - meRow;
      const label = GEN_NAMES[diff] ?? (diff < 0 ? `上${Math.abs(diff)}辈` : `下${diff}辈`);
      return { row, y: row * GRID, label, isMe: diff === 0 };
    });
  }, [nodes, GRID]);

  const onMoveEnd = useCallback((_event: unknown, vp: Viewport) => {
    setViewport(vp);
  }, []);

  const onMove = useCallback((_event: unknown, vp: Viewport) => {
    setViewport(vp);
  }, []);

  // fitView 之后也需要更新 viewport
  useEffect(() => {
    // 延迟获取以确保 fitView 动画完成后
    const timer = setTimeout(() => {
      const vp = reactFlowInstance.getViewport();
      setViewport(vp);
    }, 100);
    return () => clearTimeout(timer);
  }, [nodes, reactFlowInstance]);

  return (
    <div className="app-container">
      {/* Header Panel */}
      <div className="header">
        <h1>KinNet 图谱计算</h1>
        <p>基于有向图的最短路径亲戚称谓推导引擎</p>
      </div>

      {/* Main Graph Canvas */}
      <div style={{ flex: 1, width: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connectMode ? onConnect : undefined}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          onNodeClick={onNodeClick}
          onMoveEnd={onMoveEnd}
          onMove={onMove}
          nodeTypes={nodeTypes}
          snapToGrid={true}
          snapGrid={[210, 210]}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          minZoom={0.15}
          maxZoom={2}
          className={connectMode ? 'connect-mode-on' : 'connect-mode-off'}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={210}
            size={1}
            color="#475569"
            style={{ strokeDasharray: '5 5', opacity: 0.5 }}
          />
          <Controls position="top-right" />
        </ReactFlow>

        {/* 辈分标签 */}
        {viewport && (
        <div className="generation-labels" style={{ pointerEvents: 'none' }}>
          {generationLabels.map(gen => {
            const screenY = gen.y * viewport.zoom + viewport.y;
            const rowHeight = GRID * viewport.zoom;
            return (
              <div
                key={gen.row}
                className={`generation-label ${gen.isMe ? 'generation-label-me' : ''}`}
                style={{
                  top: screenY,
                  height: rowHeight,
                }}
              >
                <span className="generation-label-text">{gen.label}</span>
                <div className="generation-line" />
              </div>
            );
          })}
        </div>
        )}

        {/* Node Detail Panel */}
        {selectedDetail && (
          <div className="detail-panel">
            <div className="detail-panel-header">
              <span className={`detail-gender-badge ${selectedDetail.gender === 'M' ? 'male' : 'female'}`}>
                {selectedDetail.gender === 'M' ? '男' : '女'}
              </span>
              <h3 className="detail-panel-title">{selectedDetail.title}</h3>
            </div>

            {selectedDetail.path_desc && selectedDetail.match_type !== 'self' && (
              <div className="detail-section">
                <div className="detail-section-label">和你的关系</div>
                <div className="detail-path-desc">{selectedDetail.path_desc}</div>
              </div>
            )}

            {selectedDetail.aliases && selectedDetail.aliases.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-label">所有称呼</div>
                <div className="detail-aliases">
                  {selectedDetail.aliases.map((alias, i) => (
                    <span key={i} className="detail-alias-tag">{alias}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedDetail.chain && (
              <div className="detail-section">
                <div className="detail-section-label">编码链</div>
                <div className="detail-chain-code">{selectedDetail.chain}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Controls */}
      <div className="controls-panel">
        <button className="ctrl-btn ctrl-btn-icon" onClick={() => setShowHelp(true)} title="使用说明">
          <HelpCircle size={16} />
        </button>
        <button
          className={`ctrl-btn ctrl-btn-icon ${connectMode ? 'ctrl-btn-active' : ''}`}
          onClick={() => setConnectMode(m => !m)}
          title={connectMode ? '关闭连线模式' : '开启连线模式'}
        >
          <Link size={16} />
        </button>
        <div className="ctrl-divider" />
        <button className="ctrl-btn ctrl-btn-green" onClick={setAsMe}>
          设为「我」
        </button>
        <div className="ctrl-divider" />
        <div className="random-gen-group">
          <span className="random-gen-label">随机生成</span>
          <div className="random-gen-stepper">
            <button
              className="stepper-btn"
              onClick={() => setRandomNodeCount(c => Math.max(1, c - 1))}
            >-</button>
            <input
              type="number"
              min={1}
              max={200}
              value={randomNodeCount}
              onChange={(e) => setRandomNodeCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 1)))}
              className="stepper-input"
            />
            <button
              className="stepper-btn"
              onClick={() => setRandomNodeCount(c => Math.min(200, c + 1))}
            >+</button>
          </div>
          <span className="random-gen-unit">人</span>
          <button
            className="ctrl-btn ctrl-btn-purple"
            onClick={generateRandomGraph}
            disabled={isGenerating}
          >
            {isGenerating ? '生成中...' : '生成'}
          </button>
        </div>
        <div className="ctrl-divider" />
        <button className="ctrl-btn ctrl-btn-icon" onClick={exportImage} title="导出图片">
          <Download size={16} />
        </button>
      </div>

      {/* 使用说明弹窗 */}
      {showHelp && (
        <div className="help-overlay" onClick={() => { setShowHelp(false); localStorage.setItem('kinnet_help_seen', '1'); }}>
          <div className="help-modal" onClick={e => e.stopPropagation()}>
            <div className="help-header">
              <h2>使用说明</h2>
              <button className="help-close" onClick={() => { setShowHelp(false); localStorage.setItem('kinnet_help_seen', '1'); }}>×</button>
            </div>
            <div className="help-body">
              <div className="help-section-title">基础操作</div>
              <div className="help-item">
                <span className="help-icon">👆</span>
                <span><strong>单击</strong>节点选中，<strong>再点一下</strong>展开称谓详情</span>
              </div>
              <div className="help-item">
                <span className="help-icon">📌</span>
                <span>拖拽节点调整位置；<strong>同辈左边为长、右边为幼</strong>，位置决定称谓（如伯父/叔叔）</span>
              </div>
              <div className="help-item">
                <span className="help-icon">🔍</span>
                <span>双指缩放画布，拖拽平移画布</span>
              </div>

              <div className="help-section-title">添加亲属</div>
              <div className="help-item">
                <span className="help-icon">➕</span>
                <span>选中节点后出现 <strong>+</strong> 按钮，点击添加父母/子女/配偶</span>
              </div>
              <div className="help-item">
                <span className="help-icon">🔗</span>
                <span>开启<strong>连线模式</strong>（底部 🔗 按钮）后，从彩色连接点拖线到另一节点建立关系</span>
              </div>
              <div className="help-item">
                <span className="help-icon">🗑️</span>
                <span>悬停节点右上角出现删除按钮</span>
              </div>

              <div className="help-section-title">称谓推导</div>
              <div className="help-item">
                <span className="help-icon">🎯</span>
                <span><strong>「设为我」</strong>选中一个节点后点击，切换视角重算所有称谓</span>
              </div>
              <div className="help-item">
                <span className="help-icon">🎲</span>
                <span><strong>随机生成</strong>家谱，自动布局并推导称谓</span>
              </div>

              <div className="help-section-title">其他</div>
              <div className="help-item">
                <span className="help-icon">📸</span>
                <span><strong>下载</strong>按钮导出当前家谱为图片</span>
              </div>
              <div className="help-item">
                <span className="help-icon">💡</span>
                <span>连接点颜色：<strong style={{color:'#818cf8'}}>紫色</strong>=父母、<strong style={{color:'#34d399'}}>绿色</strong>=子女、<strong style={{color:'#f472b6'}}>粉色</strong>=配偶</span>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function App() {
  return (
    <ReactFlowProvider>
      <AppInner />
    </ReactFlowProvider>
  );
}

export default App;
