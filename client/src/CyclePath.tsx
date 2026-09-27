import { CycleInfo, Project } from './types';

/** 成环路径：沿环上的边从首个节点开始走完一环。 */
export function CyclePath({ project, cycle }: { project: Project; cycle: CycleInfo }) {
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  const edgeSet = new Set(cycle.edgeIds);
  const name = (id: string) => nodeById.get(id)?.name ?? id;

  const chain: string[] = [];
  const start = cycle.nodeIds[0];
  if (start) {
    chain.push(start);
    let cur = start;
    for (let i = 0; i < cycle.edgeIds.length; i++) {
      const e = project.edges.find((ed) => edgeSet.has(ed.id) && ed.from === cur);
      if (!e) break;
      chain.push(e.to);
      cur = e.to;
    }
  }

  return (
    <div className="cycle-path">
      <p className="hint">成环路径（{cycle.nodeIds.length} 条口令）：</p>
      <p className="cycle-path-line">
        {chain.map((id, i) => (
          <span key={`${id}-${i}`} className="whatif-hop">
            {i > 0 && <span className="whatif-hop-edge"> → </span>}
            <span className="whatif-hop-node hop-cycle">{name(id)}</span>
          </span>
        ))}
      </p>
    </div>
  );
}
