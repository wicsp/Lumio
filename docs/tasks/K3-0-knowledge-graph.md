# K3-0 全库知识图谱

依据：[ADR 0040](../adr/0040-knowledge-graph-endpoint.md)（Implemented；2026-11-08 人类批准并授权实现 K3-1 至 K3-3）。
必读：`docs/DESIGN.md`、`docs/design/knowledge.md`、`web.md`、`security.md`。

## 目标

在知识页一眼看到整个知识库的链接结构：哪些笔记是枢纽、哪些是孤岛、论文和想法怎么连在一起。

## 现状

- `index.sqlite` 已保存链接图；`GET /v1/notes/<ref>/links` 按单篇返回出链与反链（含私密过滤）。
- #115 已有以一篇笔记为中心的关系图（一层 / 两层），以及纯前端的力导向布局与 SVG 渲染（`apps/web/src/client/graph/`）。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| K3-1 | 契约：`KnowledgeGraphArgs`、`KnowledgeGraph`（ADR 0040 第 1 节） | Claude 起草，人类批准 | `packages/schema` |
| K3-2 | Hub：`GET /v2/knowledge/graph`，从索引读取节点与边，私密 / 类型 / 旧笔记过滤，合并重复边 | 后端（Codex） | `packages/knowledge`、`packages/storage`、`apps/hub` |
| K3-3 | Web：知识页「图谱」视图、类型筛选、隐藏孤立笔记、300 节点上限、分批布局 | 前端（Claude） | `packages/api-client`、`apps/web` |

K3-2、K3-3 依赖 K3-1；K3-3 依赖 K3-2 的路由。

实施状态（2026-11-08）：K3-1、K3-2、K3-3 全部完成；契约、权限、索引快照、过滤、节点上限和可取消布局均有 fixtures 回归测试。项目依赖图和单篇关系图沿用 #115。

## K3-1 契约要点

```ts
// packages/schema/src/knowledge-graph.ts
export const KnowledgeGraphArgs = z.strictObject({
  include_private: z.boolean().optional(),   // 查询串 "true" / "false"
  type: z.enum(NOTE_TYPES).optional(),
  include_legacy: z.boolean().optional(),
});
export const KnowledgeGraphEdge = z.strictObject({ from: z.string(), to: z.string(), count: z.number().int().positive() });
export const KnowledgeGraph = z.strictObject({
  nodes: z.array(NoteRef),
  edges: z.array(KnowledgeGraphEdge),
  dangling: z.number().int().nonnegative(),
  generated_at: Timestamp,
});
```

- 契约测试：`edges` 的 `from` / `to` 必须出现在 `nodes` 的 `path` 中（用 superRefine 校验）；没有自环；同一对只出现一次。

## K3-2 后端验收要点

- 只有 human 身份可调用；agent / runtime 返回 `FORBIDDEN`，不进入能力目录与 SKILL.md。
- 数据来自索引，不重新解析文件；结果与逐篇调用 `links` 拼出来的图一致（测试里用 `fixtures/query-vault` 对比）。
- `include_private=false` 时私密笔记不在 `nodes` 中，指向或来自私密笔记的边也不出现；`type` 只保留该类节点及两端都在其中的边。
- 旧任务 / 项目 / 例行笔记默认不出现；`.trash/` 中的笔记永不出现；AI 区块与代码块里的链接不算。
- 同一对笔记的多条链接合并为一条边，`count` 计数；悬空链接只计入 `dangling`。
- 测试只用 `fixtures/` 的合成数据。

## K3-3 Web 验收要点

- 知识页工具栏增加「列表 / 图谱」切换；图谱沿用私密开关与类型筛选，另加「隐藏孤立笔记」。
- 节点按类型着色、按链接数（`count` 之和）定大小，悬停高亮邻居，点节点打开笔记详情。
- 超过 300 个节点时默认保留链接数最多的 300 个，并提示用类型筛选缩小范围。
- 布局分批计算（例如每帧若干次迭代），计算期间界面不卡住；切换筛选时丢弃过期的计算。

## 不做

- 社区发现、聚类着色、时间轴回放；在 Hub 里计算布局；对 agent 开放全库图。
