# KinNet - 中国亲戚关系称谓图谱

可视化构建家庭关系图，自动推导中文亲戚称谓。

**在线体验：https://kin-net.vercel.app/**

> 这是一个 Vibe Coding 项目，主要由 Gemini 2.5 Pro 和 Claude Opus 4 协助完成。

## 功能

- **可视化家谱编辑** — 拖拽式画布，一键添加父母/子女/配偶
- **称谓自动推导** — 基于图最短路径 + 编码链 + CSV 规则表，实时计算所有人的称谓
- **随机家谱生成** — 输入人数，自动生成合理的家庭结构
- **切换视角** — 选中任意节点「设为我」，重算所有称谓
- **导出图片** — 一键导出家谱为 PNG
- **辈分标签** — 画布左侧展示辈分层级

## 推导原理

```
建图 → BFS最短路径 → 路径编码(f/m/s/d/h/w/ob/lb/os/ls) → 三级匹配查表 → 输出称谓
```

## 技术栈

React + TypeScript + Vite + [React Flow](https://reactflow.dev/)

纯前端项目，无后端依赖。

## 运行

```bash
cd frontend
npm install
npm run dev
```

## 构建

```bash
npm run build  # 产物在 frontend/dist
```

## License

MIT
