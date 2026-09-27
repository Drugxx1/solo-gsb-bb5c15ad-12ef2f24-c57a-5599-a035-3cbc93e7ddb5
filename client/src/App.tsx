import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadProject, saveProject } from './api';
import { CrewPanel } from './CrewPanel';
import { GraphCanvas, Selection } from './GraphCanvas';
import { computeCrewSchedule, computeSchedule, normalizeCrewSize } from './schedule';
import { SidePanel } from './SidePanel';
import { Timeline } from './Timeline';
import { CommandNode, CrewScheduleResult, Project, ScheduleResult } from './types';
import { useSimulation } from './useSimulation';

const EMPTY: Project = { nodes: [], edges: [] };

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [selection, setSelection] = useState<Selection | null>(null);

  // 初始加载
  useEffect(() => {
    loadProject()
      .then(setProject)
      .catch((e) => setLoadError(String(e?.message ?? e)));
  }, []);

  // 实时重算最早执行时间
  const schedule: ScheduleResult | null = useMemo(
    () => (project ? computeSchedule(project) : null),
    [project],
  );

  // 班组排程随编辑重算（原排程与模拟规则不变；有环时结果内只含成环路径）
  const crewSchedule: CrewScheduleResult | null = useMemo(
    () => (project ? computeCrewSchedule(project) : null),
    [project],
  );

  // 出现环依赖时保留上次有效排程
  const [lastValid, setLastValid] = useState<ScheduleResult | null>(null);
  useEffect(() => {
    if (schedule?.ok) setLastValid(schedule);
  }, [schedule]);
  const effectiveSchedule = schedule?.ok ? schedule : lastValid;
  const cycle = schedule && !schedule.ok ? schedule.cycle : undefined;

  const sim = useSimulation(project ?? EMPTY, effectiveSchedule);

  // 本地持久化（防抖）
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((p: Project) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(() => {
      saveProject(p)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 400);
  }, []);

  const update = useCallback(
    (fn: (p: Project) => Project) => {
      setProject((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const addNode = useCallback(() => {
    const id = crypto.randomUUID();
    update((p) => ({
      ...p,
      nodes: [
        ...p.nodes,
        { id, name: `口令${p.nodes.length + 1}`, duration: 3, x: 120 + p.nodes.length * 30, y: 120 + p.nodes.length * 24 },
      ],
    }));
    setSelection({ type: 'node', id });
  }, [update]);

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }));
    },
    [update],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<Pick<CommandNode, 'name' | 'duration' | 'crew'>>) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
    },
    [update],
  );

  const deleteNode = useCallback(
    (id: string) => {
      update((p) => ({
        nodes: p.nodes.filter((n) => n.id !== id),
        edges: p.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      setSelection(null);
    },
    [update],
  );

  const addEdge = useCallback(
    (from: string, to: string) => {
      update((p) => {
        if (p.edges.some((e) => e.from === from && e.to === to)) return p;
        return { ...p, edges: [...p.edges, { id: crypto.randomUUID(), from, to, minDelay: 0 }] };
      });
    },
    [update],
  );

  const updateEdge = useCallback(
    (id: string, patch: { minDelay?: number }) => {
      update((p) => ({ ...p, edges: p.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
    },
    [update],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      update((p) => ({ ...p, edges: p.edges.filter((e) => e.id !== id) }));
      setSelection(null);
    },
    [update],
  );

  const setDeadlineEnabled = useCallback(
    (enabled: boolean) => {
      update((p) => ({
        ...p,
        deadline: {
          enabled,
          // 首次启用时默认取当前最短工期，便于直接看到关键链
          seconds: p.deadline?.seconds ?? Math.ceil(effectiveSchedule?.makespan ?? 30),
        },
      }));
    },
    [update, effectiveSchedule],
  );

  const setDeadlineSeconds = useCallback(
    (seconds: number) => {
      update((p) => ({ ...p, deadline: { enabled: p.deadline?.enabled ?? true, seconds } }));
    },
    [update],
  );

  // 班组人数（正整数）：缩小时把超过新容量的用人数夹紧，保证“用人数 ≤ 班组人数”恒成立
  const setCrewSize = useCallback(
    (size: number) => {
      if (!Number.isInteger(size) || size < 1) return;
      update((p) => ({
        ...p,
        crewSize: size,
        nodes: p.nodes.map((n) =>
          n.crew !== undefined && n.crew > size ? { ...n, crew: size } : n,
        ),
      }));
    },
    [update],
  );

  if (loadError) {
    return <div className="boot-message">加载失败：{loadError}</div>;
  }
  if (!project) {
    return <div className="boot-message">正在加载口令沙盘…</div>;
  }

  const simActive = sim.state === 'running' || sim.state === 'paused';
  const canStart = project.nodes.length > 0 && sim.state !== 'running' && sim.state !== 'paused';
  const deadline = project.deadline;
  const backward = effectiveSchedule?.backward;
  const crewSize = normalizeCrewSize(project.crewSize);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>舞台换景口令沙盘</h1>
        <button onClick={addNode}>＋ 添加口令</button>
        <span className="sep" />
        {sim.state === 'idle' || sim.state === 'finished' ? (
          <button className="primary" disabled={!canStart} onClick={sim.start}>
            ▶ 开始模拟
          </button>
        ) : sim.state === 'running' ? (
          <button className="primary" onClick={sim.pause}>⏸ 暂停</button>
        ) : (
          <button className="primary" onClick={sim.resume}>⏵ 继续</button>
        )}
        <button disabled={sim.state === 'idle'} onClick={sim.reset}>⟲ 重置</button>
        <span className="sim-clock">
          {sim.state !== 'idle' && `t = ${sim.time.toFixed(1)}s`}
          {sim.state === 'finished' && ' · 全部完成'}
        </span>
        <span className="sep" />
        <label className="deadline-toggle" title="按全部后继约束反向计算最晚开始与浮动">
          <input
            type="checkbox"
            checked={deadline?.enabled ?? false}
            onChange={(e) => setDeadlineEnabled(e.target.checked)}
          />
          开场截止
        </label>
        {deadline?.enabled && (
          <span className="deadline-ctrl">
            <input
              type="number"
              min={0}
              step={0.5}
              value={deadline.seconds}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) setDeadlineSeconds(v);
              }}
            />
            <span className="deadline-unit">s</span>
            {backward && backward.overrun > 0 && (
              <span className="overrun">超期 {round1(backward.overrun)}s</span>
            )}
          </span>
        )}
        <span className="sep" />
        <label className="crew-size-ctrl" title="班组排程可用人数（正整数）">
          班组人数
          <input
            type="number"
            min={1}
            step={1}
            value={crewSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 1) setCrewSize(v);
            }}
          />
          <span className="deadline-unit">人</span>
        </label>
        <span className="spacer" />
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}
        </span>
      </header>

      {cycle && (
        <div className="cycle-banner">
          ⚠ 检测到环依赖（{cycle.nodeIds.length} 条口令成环），已保留上次有效排程；成环路径已红色高亮。
        </div>
      )}

      <div className="main">
        <div className="canvas-wrap">
          <GraphCanvas
            project={project}
            schedule={effectiveSchedule}
            cycle={cycle}
            runtime={sim.runtime}
            selection={selection}
            onSelect={setSelection}
            onMoveNode={moveNode}
            onAddEdge={addEdge}
          />
        </div>
        <SidePanel
          project={project}
          schedule={effectiveSchedule}
          selection={selection}
          cycle={cycle}
          onUpdateNode={updateNode}
          onUpdateEdge={updateEdge}
          onDeleteNode={deleteNode}
          onDeleteEdge={deleteEdge}
        />
      </div>

      {crewSchedule && <CrewPanel project={project} result={crewSchedule} />}

      <Timeline
        project={project}
        schedule={effectiveSchedule}
        cycle={cycle}
        runtime={sim.runtime}
        simTime={sim.time}
        simActive={simActive || sim.state === 'finished'}
      />
    </div>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
