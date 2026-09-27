import { BackwardInfo, CommandEdge, CrewScheduleResult, CycleInfo, Project, ScheduleResult } from './types';

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
 * 班组排程：在前置完成与等待约束之上叠加容量约束的不抢占可行排程（串行调度方案）。
 *
 * 每轮从“全部前置均已排定”的口令中，先按前置允许开始时刻
 *   ready(v) = max(0, max over 前置 e:u→v 的 start(u)+duration(u)+minDelay(e))
 * 排序，相同再按口令 id 字典序，选出一个口令；
 * 随后将其放入不早于 ready(v)、且在整个 [s, s+duration(v)) 内
 * 已排定口令的用人数之和不超过班组人数的最早位置——可填入已排定口令之间的空档。
 * 占用按 [开始, 结束) 计算；零时长口令不占人，直接排在其允许开始时刻。
 *
 * 该过程不移动任何已排定口令（不抢占）。图中存在环时复用与原排程相同的成环路径，
 * 不输出班组排程结果。
 */
export function computeCrewSchedule(project: Project): CrewScheduleResult {
  const { nodes, edges } = project;
  const capacity = normalizeCrewSize(project.crewSize);
  const durationOf = new Map(nodes.map((n) => [n.id, n.duration]));
  const demandOf = new Map(nodes.map((n) => [n.id, n.crew ?? 0]));

  const indegree = new Map<string, number>();
  const incoming = new Map<string, { from: string; minDelay: number }[]>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    incoming.get(e.to)!.push({ from: e.from, minDelay: e.minDelay });
  }

  const starts: Record<string, number> = {};
  const ends: Record<string, number> = {};
  /** 已排定且占人的口令（零时长不进表） */
  const placed: { id: string; start: number; end: number; demand: number }[] = [];

  // 全部前置已排定的口令：ready 时刻可直接由已排定前置算出
  const readyOf = (id: string): number => {
    let r = 0;
    for (const { from, minDelay } of incoming.get(id) ?? []) {
      const candidate = (ends[from] ?? 0) + minDelay;
      if (candidate > r) r = candidate;
    }
    return r;
  };

  const ready = new Set<string>();
  for (const [id, deg] of indegree) {
    if (deg === 0) ready.add(id);
  }

  let processed = 0;
  while (ready.size > 0) {
    let chosen: string | undefined;
    let chosenReady = Infinity;
    for (const id of ready) {
      const r = readyOf(id);
      if (r < chosenReady - EPS || (Math.abs(r - chosenReady) < EPS && (chosen === undefined || id < chosen))) {
        chosen = id;
        chosenReady = r;
      }
    }
    const id = chosen!;
    ready.delete(id);
    processed++;

    const duration = durationOf.get(id) ?? 0;
    // 服务端校验保证用人数 ≤ 班组人数；此处再夹紧，避免异常旧数据导致无可行位置
    const demand = Math.min(demandOf.get(id) ?? 0, capacity);
    const start = earliestCrewStart(placed, capacity, chosenReady, duration, demand);
    starts[id] = start;
    ends[id] = start + duration;
    if (duration > EPS && demand > 0) {
      placed.push({ id, start, end: start + duration, demand });
    }

    // 该口令排定后，后继可能进入“全部前置已排定”集合
    for (const e of edges) {
      if (e.from !== id || !indegree.has(e.to)) continue;
      const deg = indegree.get(e.to)! - 1;
      indegree.set(e.to, deg);
      if (deg === 0) ready.add(e.to);
    }
  }

  if (processed !== nodes.length) {
    return { ok: false, capacity, starts: {}, ends: {}, demand: {}, makespan: 0, cycle: findCycle(project, indegree) };
  }

  let makespan = 0;
  for (const n of nodes) makespan = Math.max(makespan, ends[n.id] ?? 0);
  const demand: Record<string, number> = {};
  for (const n of nodes) demand[n.id] = demandOf.get(n.id) ?? 0;
  return { ok: true, capacity, starts, ends, demand, makespan };
}

/** 班组人数（正整数）；缺省或非法时按旧数据默认 1。 */
export function normalizeCrewSize(crewSize: number | undefined): number {
  return typeof crewSize === 'number' && Number.isFinite(crewSize) && crewSize >= 1 ? crewSize : 1;
}

/**
 * 求不早于 ready、整个 [t, t+duration) 内总用人数不超过 capacity 的最早 t。
 * 不抢占：仅在已排定口令形成的负载曲线上寻找可行窗口，允许填入空档。
 * 从 ready 起扫描；遇到首个超载段就把起点整体滑到该超载段结束再继续
 * （更早的位置无法绕开首个超载段）。零时长不占人，恒可排在 ready。
 */
function earliestCrewStart(
  placed: { start: number; end: number; demand: number }[],
  capacity: number,
  ready: number,
  duration: number,
  demand: number,
): number {
  if (duration <= EPS || demand <= 0) return ready;

  let t = ready;
  for (;;) {
    // 候选窗口 [t, t+duration) 内的已排定负载事件；占用按 [开始, 结束) 计算
    const deltas = new Map<number, number>();
    for (const p of placed) {
      if (p.start >= t + duration - EPS || p.end <= t + EPS) continue;
      if (p.start > t + EPS) deltas.set(p.start, (deltas.get(p.start) ?? 0) + p.demand);
      if (p.end < t + duration - EPS) deltas.set(p.end, (deltas.get(p.end) ?? 0) - p.demand);
    }
    // 同坐标事件合并（结束减员与开始增员同点时先减后加，符合半开区间 [s,e)）
    const events = [...deltas.entries()]
      .map(([at, delta]) => ({ at, delta }))
      .sort((a, b) => a.at - b.at);

    // t 处的已排定负载作为基线，沿事件点找首个超载区间 [overStart, overEnd)
    let load = 0;
    for (const p of placed) {
      if (p.start <= t + EPS && p.end > t + EPS && p.start < t + duration - EPS) load += p.demand;
    }
    let overStart: number | undefined;
    let overEnd: number | undefined;
    if (load + demand > capacity) overStart = t;
    for (const { at, delta } of events) {
      load += delta;
      if (overStart === undefined) {
        if (load + demand > capacity) overStart = at;
      } else if (load + demand <= capacity) {
        overEnd = at;
        break;
      }
    }
    if (overStart === undefined) return t; // 整个窗口均不超载

    // 任何早于超载段结束的起点都会与该超载区间相交，故最早只能整体滑到 overEnd；
    // 超载延续到候选窗口末端之外时滑到窗口末端，下一轮重新扫描新进入的已排定口令
    t = overEnd ?? t + duration;
  }
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
