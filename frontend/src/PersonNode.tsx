import React, { useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow, MarkerType } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { UserCircle, UserCircle2, Trash2 } from 'lucide-react';
import { inferKinship } from './kinshipInference';

export type PersonNodeData = {
    name: string;
    role: string;
    gender: 'M' | 'F';
    isMe?: boolean;
};

let nodeIdCounter = 0;

export function PersonNode({ id, data, selected }: NodeProps) {
    const { name, role, gender, isMe } = data as PersonNodeData;
    const isMale = gender === 'M';
    const { getNodes, setNodes, getEdges, setEdges } = useReactFlow();
    const [activeAdd, setActiveAdd] = useState<'top' | 'bottom' | 'left' | 'right' | null>(null);
    const isAddingRef = useRef(false);

    // Flip animation state
    const [isFlipping, setIsFlipping] = useState(false);
    const [displayName, setDisplayName] = useState(name);
    const prevNameRef = useRef(name);
    const isFirstRender = useRef(true);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            setDisplayName(name);
            prevNameRef.current = name;
            return;
        }
        if (name !== prevNameRef.current) {
            setIsFlipping(true);
            // Swap text at the midpoint when card is edge-on (40% of 700ms)
            const midTimer = setTimeout(() => {
                setDisplayName(name);
            }, 280);
            // End flip after full animation completes
            const endTimer = setTimeout(() => {
                setIsFlipping(false);
            }, 700);
            prevNameRef.current = name;
            return () => {
                clearTimeout(midTimer);
                clearTimeout(endTimer);
            };
        }
    }, [name]);

    const handleQuickAddClick = (dir: 'top' | 'bottom' | 'left' | 'right', e: React.MouseEvent) => {
        e.stopPropagation();
        setActiveAdd(dir);
    };

    const handleQuickAdd = async (dir: 'top' | 'bottom' | 'left' | 'right', newGender: 'M' | 'F', e: React.MouseEvent) => {
        e.stopPropagation(); // prevent drag/select

        // 防连击
        if (isAddingRef.current) return;
        isAddingRef.current = true;

        let type: 'parent' | 'child' | 'spouse' = 'spouse';
        if (dir === 'top') type = 'parent';
        if (dir === 'bottom') type = 'child';

        const nodes = getNodes();
        const edges = getEdges();

        // ── 前置校验：在创建任何节点之前检查 ──
        if (type === 'spouse') {
            const hasSpouse = edges.some(e =>
                (e.source === id && e.sourceHandle?.startsWith('spouse')) ||
                (e.target === id && e.targetHandle?.startsWith('spouse'))
            );
            if (hasSpouse) {
                setActiveAdd(null);
                isAddingRef.current = false;
                return;
            }
        }
        if (type === 'parent') {
            const parentEdges = edges.filter(e => e.target === id && e.targetHandle === 'parent');
            if (parentEdges.length >= 2) {
                setActiveAdd(null);
                isAddingRef.current = false;
                return;
            }
        }

        const GRID = 210;
        const newNodeId = `node-${Date.now()}-${++nodeIdCounter}`;
        const randomSuffix = Date.now().toString().slice(-4);

        let newName = '';

        if (type === 'parent') {
            newName = newGender === 'M' ? `父亲_${randomSuffix}` : `母亲_${randomSuffix}`;
        } else if (type === 'child') {
            newName = newGender === 'M' ? `儿子_${randomSuffix}` : `女儿_${randomSuffix}`;
        } else {
            newName = newGender === 'M' ? `丈夫_${randomSuffix}` : `妻子_${randomSuffix}`;
        }

        const myNode = nodes.find(n => n.id === id);
        const pos = myNode ? { ...myNode.position } : { x: 0, y: 0 };

        if (type === 'parent') {
            pos.y -= GRID;
            // 如果已有一个父母，把新父/母放到已有父/母旁边（丈夫左妻子右）
            const parentEdges = edges.filter(e => e.target === id && e.targetHandle === 'parent');
            if (parentEdges.length === 1) {
                const existingParentId = parentEdges[0].source;
                const existingParent = nodes.find(n => n.id === existingParentId);
                if (existingParent) {
                    const existingGender = (existingParent.data as PersonNodeData).gender;
                    if (existingGender === 'M') {
                        // 已有父亲，新母亲放父亲右边
                        pos.x = existingParent.position.x + GRID;
                    } else {
                        // 已有母亲，新父亲放母亲左边
                        pos.x = existingParent.position.x - GRID;
                    }
                }
            }
        } else if (type === 'child') {
            pos.y += GRID;
        } else {
            // 配偶：丈夫在左，妻子在右
            const myGender = gender as string;
            if (myGender === 'M') {
                // 我是男性，新配偶是女性（妻子），放右边
                pos.x += GRID;
            } else {
                // 我是女性，新配偶是男性（丈夫），放左边
                pos.x -= GRID;
            }
        }

        // Prevent overlapping: push same-row nodes aside
        const checkOverlap = (p: { x: number, y: number }) => {
            return nodes.some(n => n.id !== id && Math.abs(n.position.x - p.x) < 140 && Math.abs(n.position.y - p.y) < 140);
        };

        if (type === 'parent' || type === 'child') {
            while (checkOverlap(pos)) {
                pos.x += GRID;
            }
        } else if (type === 'spouse') {
            // 配偶位置冲突时，需要把同行节点挤开
            if (checkOverlap(pos)) {
                const myGender = gender as string;
                const rowY = pos.y;
                // 找同行所有节点（不含自己）
                const sameRow = nodes.filter(n => n.id !== id && Math.abs(Math.round(n.position.y) - rowY) < 10);

                // 辅助：获取配偶 id
                const getSpouseId = (nid: string) => {
                    for (const edge of edges) {
                        if (edge.sourceHandle?.startsWith('spouse')) {
                            if (edge.source === nid) return edge.target;
                            if (edge.target === nid) return edge.source;
                        }
                    }
                    return null;
                };

                // 构建夫妻组
                const visited = new Set<string>();
                const groups: { ids: string[]; leftX: number; rightX: number }[] = [];
                for (const n of sameRow) {
                    if (visited.has(n.id)) continue;
                    visited.add(n.id);
                    const spId = getSpouseId(n.id);
                    const spNode = spId ? sameRow.find(s => s.id === spId) : null;
                    if (spNode && !visited.has(spNode.id)) {
                        visited.add(spNode.id);
                        groups.push({
                            ids: [n.id, spNode.id],
                            leftX: Math.min(n.position.x, spNode.position.x),
                            rightX: Math.max(n.position.x, spNode.position.x)
                        });
                    } else {
                        groups.push({ ids: [n.id], leftX: n.position.x, rightX: n.position.x });
                    }
                }

                if (myGender === 'M') {
                    // 妻子在右边，需要把右边冲突的组往右推
                    groups.filter(g => g.leftX >= pos.x - GRID / 2).sort((a, b) => a.leftX - b.leftX)
                        .forEach(g => {
                            if (g.leftX < pos.x + GRID) {
                                const shift = pos.x + GRID - g.leftX;
                                g.ids.forEach(gid => {
                                    const gNode = nodes.find(n => n.id === gid);
                                    if (gNode) gNode.position.x += shift;
                                });
                                g.leftX += shift;
                                g.rightX += shift;
                            }
                        });
                } else {
                    // 丈夫在左边，需要把左边冲突的组往左推
                    groups.filter(g => g.rightX <= pos.x + GRID / 2).sort((a, b) => b.rightX - a.rightX)
                        .forEach(g => {
                            if (g.rightX > pos.x - GRID) {
                                const shift = g.rightX - (pos.x - GRID);
                                g.ids.forEach(gid => {
                                    const gNode = nodes.find(n => n.id === gid);
                                    if (gNode) gNode.position.x -= shift;
                                });
                                g.leftX -= shift;
                                g.rightX -= shift;
                            }
                        });
                }
                // 更新所有同行节点位置
                setNodes(nds => nds.map(n => {
                    const moved = sameRow.find(s => s.id === n.id);
                    if (moved) return { ...n, position: { ...moved.position } };
                    return n;
                }));
            }
        }

        const newNode = {
            id: newNodeId,
            type: 'person',
            position: pos,
            data: { name: newName, role: '', gender: newGender }
        };

        setNodes(nds => [...nds, newNode]);

        let newEdge: any = null;
        const extraEdges: any[] = [];
        if (type === 'parent') {
            newEdge = {
                id: `e-${newNodeId}-${id}`,
                source: newNodeId,
                sourceHandle: 'child',
                target: id,
                targetHandle: 'parent',
                animated: true,
                style: { stroke: '#34d399', strokeWidth: 2 },
                markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' }
            };
            // 如果已有一个父母，自动添加新父母与已有父母之间的配偶边
            const parentEdges = edges.filter(e => e.target === id && e.targetHandle === 'parent');
            if (parentEdges.length === 1) {
                const existingParentId = parentEdges[0].source;
                const existingParent = nodes.find(n => n.id === existingParentId);
                if (existingParent) {
                    const existingGender = (existingParent.data as PersonNodeData).gender;
                    // 丈夫(M) 为 source，妻子(F) 为 target
                    const husbandId = existingGender === 'M' ? existingParentId : newNodeId;
                    const wifeId = existingGender === 'M' ? newNodeId : existingParentId;
                    extraEdges.push({
                        id: `e-${husbandId}-${wifeId}`,
                        source: husbandId,
                        sourceHandle: 'spouse-r',
                        target: wifeId,
                        targetHandle: 'spouse-l',
                        animated: false,
                        style: { stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '5 5' },
                        markerEnd: { type: MarkerType.ArrowClosed, color: '#f472b6' }
                    });
                }
            }
        } else if (type === 'child') {
            newEdge = {
                id: `e-${id}-${newNodeId}`,
                source: id,
                sourceHandle: 'child',
                target: newNodeId,
                targetHandle: 'parent',
                animated: true,
                style: { stroke: '#34d399', strokeWidth: 2 },
                markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' }
            };
            // 如果当前节点有配偶，自动添加配偶→子女的边
            const spouseEdge = edges.find(e =>
                e.sourceHandle?.startsWith('spouse') &&
                (e.source === id || e.target === id)
            );
            if (spouseEdge) {
                const spouseId = spouseEdge.source === id ? spouseEdge.target : spouseEdge.source;
                extraEdges.push({
                    id: `e-${spouseId}-${newNodeId}`,
                    source: spouseId,
                    sourceHandle: 'child',
                    target: newNodeId,
                    targetHandle: 'parent',
                    animated: true,
                    style: { stroke: '#34d399', strokeWidth: 2 },
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' }
                });
            }
        } else if (type === 'spouse') {
            // 丈夫(M)作为 source(spouse-r)，妻子(F)作为 target(spouse-l)
            const myGender = gender as string;
            const husbandId = myGender === 'M' ? id : newNodeId;
            const wifeId = myGender === 'M' ? newNodeId : id;
            newEdge = {
                id: `e-${husbandId}-${wifeId}`,
                source: husbandId,
                sourceHandle: 'spouse-r',
                target: wifeId,
                targetHandle: 'spouse-l',
                animated: false,
                style: { stroke: '#f472b6', strokeWidth: 2, strokeDasharray: '5 5' },
                markerEnd: { type: MarkerType.ArrowClosed, color: '#f472b6' }
            };
            // 当前节点已有的子女也自动成为新配偶的子女
            const childEdges = edges.filter(e => e.source === id && e.sourceHandle === 'child');
            for (const ce of childEdges) {
                extraEdges.push({
                    id: `e-${newNodeId}-${ce.target}`,
                    source: newNodeId,
                    sourceHandle: 'child',
                    target: ce.target,
                    targetHandle: 'parent',
                    animated: true,
                    style: { stroke: '#34d399', strokeWidth: 2 },
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#34d399' }
                });
            }
        }

        const allNewEdges = [newEdge, ...extraEdges].filter(Boolean);
        if (allNewEdges.length > 0) {
            setEdges(eds => [...eds, ...allNewEdges]);
        }
        setActiveAdd(null);

        // Fetch dynamic name relative to "Me"
        const meNode = nodes.find(n => n.data.isMe);
        if (meNode) {
            try {
                const nodesPayload = [...nodes, newNode].map(n => ({ id: n.id, ...n.data, position: n.position }));
                const edgesPayload = [...getEdges(), ...allNewEdges].map(edge => ({
                    source: edge.source,
                    target: edge.target,
                    label: edge.sourceHandle?.startsWith('spouse') ? 'spouse_of' : 'parent_of'
                }));
                const result = await inferKinship(meNode.id, newNodeId, nodesPayload, edgesPayload);
                const calculatedName = result.title || "未知亲戚";
                const calculatedRole = result.path_desc || '';
                setNodes(nds => nds.map(n => n.id === newNodeId ? { ...n, data: { ...n.data, name: calculatedName, role: calculatedRole } } : n));
            } catch (error) {
                console.error("Failed to calculate relationship name:", error);
            }
        }
        isAddingRef.current = false;
    };

    // Close active add when clicking background
    const handleNodeClick = () => {
        if (activeAdd) setActiveAdd(null);
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isMe) {
            alert("不能删除作为起点的节点！");
            return;
        }
        setNodes(nds => nds.filter(n => n.id !== id));
        setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
    };

    return (
        <div className={`custom-node ${isMale ? 'M-node' : 'F-node'} ${isMe ? 'Me' : ''} ${isFlipping ? 'card-flipping' : ''}`} onClick={handleNodeClick}>

            {/* Delete Button */}
            {!isMe && (
                <button className="delete-btn nodrag" onClick={handleDelete}>
                    <Trash2 size={12} />
                </button>
            )}

            {/* Top Handle for Parents */}
            <Handle type="target" position={Position.Top} id="parent" className="react-flow__handle handle-parent" />
            {selected && (() => {
                const parentEdges = getEdges().filter(e => e.target === id && e.targetHandle === 'parent');
                if (parentEdges.length >= 2) return null;
                if (parentEdges.length === 1) {
                    const existingParentId = parentEdges[0].source;
                    const existingParent = getNodes().find(n => n.id === existingParentId);
                    const existingGender = (existingParent?.data as PersonNodeData)?.gender;
                    const missingGender: 'M' | 'F' = existingGender === 'M' ? 'F' : 'M';
                    return (
                        <button className="quick-add top" onClick={(e) => { e.stopPropagation(); handleQuickAdd('top', missingGender, e); }}>
                            +
                        </button>
                    );
                }
                return activeAdd === 'top' ? (
                    <div className="gender-picker top nodrag" onClick={e => e.stopPropagation()}>
                        <button className="m-btn" onClick={(e) => handleQuickAdd('top', 'M', e)}>男</button>
                        <button className="f-btn" onClick={(e) => handleQuickAdd('top', 'F', e)}>女</button>
                    </div>
                ) : (
                    <button className="quick-add top" onClick={(e) => handleQuickAddClick('top', e)}>+</button>
                );
            })()}

            {/* Left Handle for Spouse */}
            <Handle type="target" position={Position.Left} id="spouse-l" className="react-flow__handle handle-spouse" />
            {selected && !isMale && getEdges().filter(e => (e.source === id && e.sourceHandle?.startsWith('spouse')) || (e.target === id && e.targetHandle?.startsWith('spouse'))).length < 1 && (
                <button className="quick-add left" onClick={(e) => { e.stopPropagation(); handleQuickAdd('left', 'M', e); }}>
                    +
                </button>
            )}

            {/* Card face content */}
            <div className="card-face">
                {/* Avatar */}
                <div className="node-avatar">
                    {isMale ? <UserCircle size={36} /> : <UserCircle2 size={36} />}
                    {isMe && <span className="me-badge">我</span>}
                </div>

                {/* Info */}
                <div className="node-info">
                    <div className="name">{displayName}</div>
                    {role && <div className="role">{role}</div>}
                </div>
            </div>

            {/* Right Handle for Spouse */}
            <Handle type="source" position={Position.Right} id="spouse-r" className="react-flow__handle handle-spouse" />
            {selected && isMale && getEdges().filter(e => (e.source === id && e.sourceHandle?.startsWith('spouse')) || (e.target === id && e.targetHandle?.startsWith('spouse'))).length < 1 && (
                <button className="quick-add right" onClick={(e) => { e.stopPropagation(); handleQuickAdd('right', 'F', e); }}>
                    +
                </button>
            )}

            {/* Bottom Handle for Children */}
            <Handle type="source" position={Position.Bottom} id="child" className="react-flow__handle handle-child" />
            {selected && (activeAdd === 'bottom' ? (
                <div className="gender-picker bottom nodrag" onClick={e => e.stopPropagation()}>
                    <button className="m-btn" onClick={(e) => handleQuickAdd('bottom', 'M', e)}>男</button>
                    <button className="f-btn" onClick={(e) => handleQuickAdd('bottom', 'F', e)}>女</button>
                </div>
            ) : (
                <button className="quick-add bottom" onClick={(e) => handleQuickAddClick('bottom', e)}>+</button>
            ))}
        </div>
    );
}
