import { BackwardInfo, CommandEdge, CycleInfo, Project, ScheduleResult } from './types';

const EPS = 1e-9;

/**
 * 计算每个口令的最早开始时间（Kahn 拓扑排序，O(V+E)）。
 * 规则：start(to) >= start(from) + duration(from) + minDelay(edge)。
 * 若图中存在环依赖，返回 ok=false 并给出一条具体的成环路径用于高亮。
 */
export function computeSchedule(project: Project): ScheduleResult {
  const { nodes, edges } = project;
  const starts: Record<string, number> = {};
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, { to: string; minDelay: number }[]>();

  for (const n of nodes) {
    indegree.set(n.id, 0);
    outgoing.set(n.id, []);
    starts[n.id] = 0;
  }
  for (const e of edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    outgoing.get(e.from)!.push({ to: e.to, minDelay: e.minDelay });
  }

  const durationOf = new Map(nodes.map((n) => [n.id, n.duration]));
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    const finishAt = starts[id] + (durationOf.get(id) ?? 0);
    for (const { to, minDelay } of outgoing.get(id) ?? []) {
      const candidate = finishAt + minDelay;
      if (candidate > starts[to]) starts[to] = candidate;
      const deg = indegree.get(to)! - 1;
      indegree.set(to, deg);
      if (deg === 0) queue.push(to);
    }
  }

  if (processed === nodes.length) {
    let makespan = 0;
    for (const n of nodes) {
      makespan = Math.max(makespan, starts[n.id] + n.duration);
    }
    const dl = project.deadline;
    const backward =
      dl?.enabled && Number.isFinite(dl.seconds) && dl.seconds >= 0
        ? computeBackward(project, starts, makespan, dl.seconds)
        : undefined;
    return { ok: true, starts, makespan, backward };
  }

  return { ok: false, starts, makespan: 0, cycle: findCycle(project, indegree) };
}

/**
 * 截止倒排（CPM 反向 pass，O(V+E)，仅在无环图上调用）。
 * 规则：latestStart(from) <= latestStart(to) - minDelay(edge) - duration(from)，
 * 无后继口令的最晚完成时间锚定在截止时刻。
 * 浮动 = 最晚开始 - 最早开始；截止早于最短工期时浮动为负，如实保留。
 * 关键链取浮动最小的节点（截止恰好等于最短工期时即浮动为 0），
 * 以及两端皆关键、且前向约束被拉紧的边。
 */
function computeBackward(
  project: Project,
  starts: Record<string, number>,
  makespan: number,
  deadline: number,
): BackwardInfo {
  const { nodes, edges } = project;
  const durationOf = new Map(nodes.map((n) => [n.id, n.duration]));
  const outdegree = new Map<string, number>();
  const incoming = new Map<string, { from: string; minDelay: number }[]>();
  for (const n of nodes) {
    outdegree.set(n.id, 0);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (!outdegree.has(e.from) || !outdegree.has(e.to)) continue;
    outdegree.set(e.from, (outdegree.get(e.from) ?? 0) + 1);
    incoming.get(e.to)!.push({ from: e.from, minDelay: e.minDelay });
  }

  // 逆 Kahn：节点出队时其全部后继已处理，最晚完成时间随之确定
  const latestStarts: Record<string, number> = {};
  const bestFinish = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of outdegree) {
    if (deg === 0) queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const finish = bestFinish.get(id) ?? deadline; // 无后继 → 锚定截止时刻
    const latestStart = finish - (durationOf.get(id) ?? 0);
    latestStarts[id] = latestStart;
    for (const pred of incoming.get(id) ?? []) {
      const cand = latestStart - pred.minDelay;
      const prev = bestFinish.get(pred.from);
      if (prev === undefined || cand < prev) bestFinish.set(pred.from, cand);
      const deg = outdegree.get(pred.from)! - 1;
      outdegree.set(pred.from, deg);
      if (deg === 0) queue.push(pred.from);
    }
  }

  const floats: Record<string, number> = {};
  let minFloat = Infinity;
  for (const n of nodes) {
    const f = (latestStarts[n.id] ?? 0) - (starts[n.id] ?? 0);
    floats[n.id] = f;
    if (f < minFloat) minFloat = f;
  }
  if (!Number.isFinite(minFloat)) minFloat = 0;

  const criticalNodeIds = nodes
    .filter((n) => Math.abs(floats[n.id] - minFloat) < EPS)
    .map((n) => n.id);
  const criticalSet = new Set(criticalNodeIds);
  const criticalEdgeIds: string[] = [];
  for (const e of edges) {
    if (!criticalSet.has(e.from) || !criticalSet.has(e.to)) continue;
    const tight = (starts[e.from] ?? 0) + (durationOf.get(e.from) ?? 0) + e.minDelay;
    if (Math.abs((starts[e.to] ?? 0) - tight) < EPS) criticalEdgeIds.push(e.id);
  }

  return {
    deadline,
    latestStarts,
    floats,
    criticalNodeIds,
    criticalEdgeIds,
    overrun: Math.max(0, makespan - deadline),
  };
}

/**
 * 在未被拓扑处理的剩余节点中找出一条具体的环路径。
 * 剩余子图中每个节点都至少有一条来自剩余节点的入边，
 * 因此沿“剩余前置”不断回溯必然重复，重复段即为一个环。
 */
function findCycle(project: Project, indegree: Map<string, number>): CycleInfo | undefined {
  const remaining = new Set<string>();
  for (const [id, deg] of indegree) {
    if (deg > 0) remaining.add(id);
  }
  if (remaining.size === 0) return undefined;

  // 剩余节点 -> 来自剩余节点的入边
  const incoming = new Map<string, { from: string; edgeId: string }[]>();
  for (const id of remaining) incoming.set(id, []);
  for (const e of project.edges) {
    if (remaining.has(e.from) && remaining.has(e.to)) {
      incoming.get(e.to)!.push({ from: e.from, edgeId: e.id });
    }
  }

  const start = remaining.values().next().value as string;
  const visitIndex = new Map<string, number>();
  const pathNodes: string[] = [];
  const pathEdges: string[] = [];
  let cur = start;

  while (!visitIndex.has(cur)) {
    visitIndex.set(cur, pathNodes.length);
    pathNodes.push(cur);
    const inc = incoming.get(cur);
    if (!inc || inc.length === 0) return undefined; // 理论上不会发生
    const next = inc[0];
    pathEdges.push(next.edgeId);
    cur = next.from;
  }

  const cycleStart = visitIndex.get(cur)!;
  return {
    nodeIds: pathNodes.slice(cycleStart),
    edgeIds: pathEdges.slice(cycleStart),
  };
}

/** 增量预演：内存中对单项改动（口令持续时长 / 约束等待秒数）试算 */
export interface WhatIfChange {
  kind: 'node' | 'edge';
  id: string;
  /** 试算输入值（不小于当前值） */
  value: number;
}

/** 一条开始时刻被实际推迟的口令及其传播前驱路径 */
export interface WhatIfDelayed {
  nodeId: string;
  /** 开始时刻实际推迟的秒数（>0） */
  delay: number;
  /** 从改动点沿被拉紧的约束传播而来的前驱节点 id（改动点在路径末端） */
  pathNodeIds: string[];
  /** 与前驱路径对应的约束边 id（在路径末端的前驱节点与其后继之间） */
  pathEdgeIds: string[];
}

export interface WhatIfResult {
  ok: boolean;
  /** 现行排程（当前图） */
  current?: ScheduleResult;
  /** 试算排程（克隆图） */
  trial?: ScheduleResult;
  /** 开始时刻实际推迟的口令 */
  delayed?: WhatIfDelayed[];
  /** 试算后图出现环时的成环路径（正常不会发生：仅放大时长/等待不会引入新环） */
  cycle?: CycleInfo;
}

/**
 * 增量预演试算（纯内存，不写入任何状态）。
 *
 * 在项目克隆上把单条口令持续时长或单条约束等待秒数改为不小于当前值的新值后重算，
 * 对比现行排程，给出总工期、开场截止超期量的变化，以及每条开始时刻被实际推迟的口令。
 *
 * 推迟量沿“试算中被拉紧的约束”（trial-tight edge，candidate 恰好等于后继新开始时刻）
 * 从改动点向下传播；前驱路径按边 ID 稳定选一路：等传播量的多个前驱中始终选 ID 最小的边。
 */
export function runWhatIf(project: Project, change: WhatIfChange): WhatIfResult {
  const current = computeSchedule(project);
  if (!current.ok) return { ok: false, current, cycle: current.cycle };

  const oldDuration = new Map(project.nodes.map((n) => [n.id, n.duration]));
  const oldEdgeById = new Map(project.edges.map((e) => [e.id, e]));

  const cloned: Project = {
    nodes: project.nodes.map((n) =>
      change.kind === 'node' && n.id === change.id ? { ...n, duration: change.value } : { ...n },
    ),
    edges: project.edges.map((e) =>
      change.kind === 'edge' && e.id === change.id ? { ...e, minDelay: change.value } : { ...e },
    ),
    deadline: project.deadline ? { ...project.deadline } : undefined,
  };
  const trial = computeSchedule(cloned);
  if (!trial.ok) return { ok: false, current, trial, cycle: trial.cycle };

  // 推迟量按拓扑序松弛一遍即可完成全部传播（图无环）
  const topo = topoOrder(cloned);
  const outgoing = new Map<string, CommandEdge[]>();
  for (const n of cloned.nodes) outgoing.set(n.id, []);
  for (const e of cloned.edges) outgoing.get(e.from)!.push(e);

  // arrival[id]：从改动点沿试算紧约束传播到 id 的推迟量（0 = 未被影响）
  // parent[id]：该推迟量对应的前驱边；等传播量时按边 ID 最小稳定选择
  const arrival = new Map<string, number>();
  const parent = new Map<string, CommandEdge>();
  if (change.kind === 'node') {
    arrival.set(change.id, Math.max(0, change.value - (oldDuration.get(change.id) ?? change.value)));
  }

  // 现行排程中某条边给后继留下的余量（无环正向排程下恒 >= 0）
  const slackOf = (e: CommandEdge): number =>
    (current.starts[e.to] ?? 0) -
    ((current.starts[e.from] ?? 0) + (oldDuration.get(e.from) ?? 0) + (oldEdgeById.get(e.id)?.minDelay ?? 0));

  for (const id of topo) {
    const du = arrival.get(id) ?? 0;
    for (const e of outgoing.get(id) ?? []) {
      let cand: number;
      if (change.kind === 'edge' && e.id === change.id) {
        // 改动边：增量先被其在现行排程中的余量吸收
        const delta = change.value - (oldEdgeById.get(e.id)?.minDelay ?? change.value);
        cand = Math.max(0, delta - Math.max(0, slackOf(e)));
      } else {
        // 其他边：上游推迟量先被该边的现有余量吸收
        if (du <= 0) continue;
        cand = Math.max(0, du - Math.max(0, slackOf(e)));
      }
      if (cand <= 0) continue;
      // 只沿“试算中被拉紧”的边传播：候选推迟量须恰好等于后继的实际推迟量
      const actual = Math.max(0, (trial.starts[e.to] ?? 0) - (current.starts[e.to] ?? 0));
      if (Math.abs(actual - cand) > EPS) continue;
      const prev = arrival.get(e.to) ?? 0;
      if (actual > prev + EPS || (Math.abs(actual - prev) < EPS && (!parent.has(e.to) || e.id < parent.get(e.to)!.id))) {
        arrival.set(e.to, actual);
        parent.set(e.to, e);
      }
    }
  }

  const delayed: WhatIfDelayed[] = [];
  for (const n of cloned.nodes) {
    if (change.kind === 'node' && n.id === change.id) continue; // 改动口令自身开始时刻不推迟
    const d = (trial.starts[n.id] ?? 0) - (current.starts[n.id] ?? 0);
    if (d <= EPS) continue;
    const pathNodeIds: string[] = [n.id];
    const pathEdgeIds: string[] = [];
    let curId = n.id;
    // 沿前驱边回溯到改动点（图无环，必然终止）
    for (;;) {
      if (change.kind === 'node' && curId === change.id) break;
      const pe = parent.get(curId);
      if (!pe) break;
      pathEdgeIds.push(pe.id);
      pathNodeIds.push(pe.from);
      curId = pe.from;
      if (change.kind === 'edge' && pe.id === change.id) break;
    }
    delayed.push({ nodeId: n.id, delay: d, pathNodeIds, pathEdgeIds });
  }
  // 推迟多者在前；同量按节点 id 稳定排序
  delayed.sort((a, b) =>
    b.delay - a.delay !== 0 ? b.delay - a.delay : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
  );

  return { ok: true, current, trial, delayed };
}

/** Kahn 拓扑排序（仅在无环图上调用）；出队顺序按 id 排序以保持稳定。 */
function topoOrder(project: Project): string[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of project.nodes) {
    indegree.set(n.id, 0);
    outgoing.set(n.id, []);
  }
  for (const e of project.edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    outgoing.get(e.from)!.push(e.to);
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of outgoing.get(id) ?? []) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) {
        ready.push(to);
        ready.sort();
      }
    }
  }
  return order;
}
