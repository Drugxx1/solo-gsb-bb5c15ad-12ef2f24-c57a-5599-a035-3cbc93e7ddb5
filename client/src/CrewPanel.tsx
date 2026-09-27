import { useState } from 'react';
import { CrewScheduleResult, CycleInfo, Project } from './types';
import { CyclePath } from './SidePanel';

interface CrewPanelProps {
  project: Project;
  /** 班组排程结果（随编辑实时重算） */
  result: CrewScheduleResult | null;
  /** 当前图的环依赖（存在时停止输出班组结果，仅展示成环路径） */
  cycle?: CycleInfo;
}

/**
 * 班组排程面板：按班组人数容量约束生成的不抢占可行排程，
 * 列出每条口令的排定起止与总工期；有环时展示成环路径并停止输出。
 */
export function CrewPanel(props: CrewPanelProps) {
  const { project, result, cycle } = props;
  const [collapsed, setCollapsed] = useState(false);

  const capacity = project.crewSize ?? 1;
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  // 展示按（开始时刻, 口令 ID）排序；排定顺序允许后排者填入空档
  const rows = result?.ok
    ? [...result.assignments].sort((a, b) =>
        a.start !== b.start ? a.start - b.start : a.nodeId < b.nodeId ? -1 : 1,
      )
    : [];

  return (
    <section className="crew-panel">
      <header className="crew-panel-head">
        <h2>班组排程</h2>
        <span className="crew-meta">班组人数 {capacity} 人</span>
        {result?.ok && project.nodes.length > 0 && (
          <span className="crew-meta">总工期 {round1(result.makespan)}s</span>
        )}
        {cycle && <span className="crew-meta crew-meta-cycle">存在环依赖，已停止输出</span>}
        <span className="spacer" />
        <button className="crew-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展开 ▾' : '收起 ▴'}
        </button>
      </header>
      {!collapsed &&
        (cycle ? (
          <div className="crew-panel-body">
            <p className="hint overrun-hint">
              当前口令图存在环依赖，班组排程已停止输出；请先解除成环约束。
            </p>
            <CyclePath project={project} cycle={cycle} />
          </div>
        ) : !result || rows.length === 0 ? (
          <div className="crew-panel-body">
            <p className="hint">暂无可排口令，请先添加口令。</p>
          </div>
        ) : (
          <div className="crew-panel-body">
            <table className="crew-table">
              <thead>
                <tr>
                  <th>口令</th>
                  <th>开始</th>
                  <th>结束</th>
                  <th>用人数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const n = nodeById.get(a.nodeId);
                  return (
                    <tr key={a.nodeId}>
                      <td>{n?.name ?? a.nodeId}</td>
                      <td>{round1(a.start)}s</td>
                      <td>{round1(a.end)}s</td>
                      <td>{n?.crew ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">
              共 {rows.length} 条口令，总工期 {round1(result.makespan)}s
              （容量 {capacity} 人，占用按 [开始, 结束) 计算，零时长不占人）。
            </p>
          </div>
        ))}
    </section>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
