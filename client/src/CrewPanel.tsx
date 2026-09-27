import { CrewScheduleResult, Project } from './types';
import { CyclePath } from './CyclePath';

interface CrewPanelProps {
  project: Project;
  /** 当前图的班组排程（面板随编辑重算，由父组件 useMemo 提供） */
  result: CrewScheduleResult;
}

const ROW_H = 24;
const LABEL_W = 104;
const PX_PER_SEC = 14;

/**
 * 班组排程面板：在原前置/等待约束之上，按班组人数容量生成的不抢占可行排程。
 * 列出每条口令的开始/结束时刻与用人数、总工期，并用迷你甘特图展示（含已排定口令间的空档）。
 * 图中存在环时不输出班组结果，仅展示与原排程相同的成环路径。
 */
export function CrewPanel({ project, result }: CrewPanelProps) {
  if (project.nodes.length === 0) {
    return (
      <section className="crew-panel empty">
        <h3>班组排程</h3>
        <p className="hint">暂无可排程口令。</p>
      </section>
    );
  }

  if (!result.ok) {
    return (
      <section className="crew-panel">
        <h3>班组排程</h3>
        <p className="hint overrun-hint">
          检测到环依赖，班组排程已停止输出；解除成环约束后自动恢复（原排程与模拟不受影响）。
        </p>
        {result.cycle && <CyclePath project={project} cycle={result.cycle} />}
      </section>
    );
  }

  const rows = [...project.nodes].sort((a, b) => {
    const sa = result.starts[a.id] ?? 0;
    const sb = result.starts[b.id] ?? 0;
    if (Math.abs(sa - sb) > 1e-9) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const width = Math.max(result.makespan * PX_PER_SEC + 40, 200);
  const height = rows.length * ROW_H + 26;
  const tickStep = niceStep(result.makespan / 8);
  const ticks: number[] = [];
  for (let t = 0; t <= result.makespan + 1e-6; t += tickStep) ticks.push(Math.round(t * 10) / 10);

  return (
    <section className="crew-panel">
      <header className="crew-head">
        <h3>班组排程</h3>
        <span className="crew-meta">
          班组人数 <b>{result.capacity}</b> 人 · 总工期 <b>{round1(result.makespan)}</b>s ·{' '}
          {project.nodes.length} 条口令
        </span>
        <span className="crew-rule hint">
          规则：每轮取全部前置已排定的口令（先按允许开始时刻、再按口令 ID 排序），放入满足人手容量的最早空档；占用按 [开始, 结束)，零时长不占人
        </span>
      </header>
      <div className="crew-body">
        <table className="crew-table">
          <thead>
            <tr>
              <th>口令</th>
              <th className="num">用人</th>
              <th className="num">开始</th>
              <th className="num">结束</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const s = result.starts[n.id] ?? 0;
              const e = result.ends[n.id] ?? s;
              const d = result.demand[n.id] ?? 0;
              return (
                <tr key={n.id}>
                  <td title={n.id}>{n.name}</td>
                  <td className="num">{d} 人</td>
                  <td className="num">{round1(s)}s</td>
                  <td className="num">{round1(e)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="crew-gantt-scroll">
          <svg width={LABEL_W + width} height={height}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(${LABEL_W + t * PX_PER_SEC},0)`}>
                <line y1={18} y2={height} className="tick-line" />
                <text y={12} textAnchor="middle" className="tick-label">
                  {t}s
                </text>
              </g>
            ))}
            {rows.map((n, i) => {
              const s = result.starts[n.id] ?? 0;
              const e = result.ends[n.id] ?? s;
              const d = result.demand[n.id] ?? 0;
              const y = 18 + i * ROW_H;
              return (
                <g key={n.id}>
                  <text x={LABEL_W - 8} y={y + ROW_H / 2 + 1} textAnchor="end" className="row-label">
                    {n.name}
                  </text>
                  {e - s > 1e-9 ? (
                    <>
                      <rect
                        x={LABEL_W + s * PX_PER_SEC}
                        y={y + 3}
                        width={(e - s) * PX_PER_SEC}
                        height={ROW_H - 7}
                        rx={4}
                        className={`crew-bar ${d === 0 ? 'zero-crew' : ''}`}
                      />
                      <text x={LABEL_W + s * PX_PER_SEC + 5} y={y + ROW_H / 2 + 1} className="bar-label">
                        {round1(s)}–{round1(e)}s{d > 0 ? ` · ${d}人` : ''}
                      </text>
                    </>
                  ) : (
                    <g>
                      <line
                        x1={LABEL_W + s * PX_PER_SEC - 4}
                        x2={LABEL_W + s * PX_PER_SEC + 4}
                        y1={y + 3}
                        y2={y + ROW_H - 4}
                        className="crew-zero-mark"
                      />
                      <text x={LABEL_W + s * PX_PER_SEC + 8} y={y + ROW_H / 2 + 1} className="bar-label">
                        {round1(s)}s · 零时长
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </section>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of candidates) if (c >= raw) return c;
  return Math.ceil(raw);
}
