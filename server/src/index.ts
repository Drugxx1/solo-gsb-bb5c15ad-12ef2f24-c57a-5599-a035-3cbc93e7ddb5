import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

interface CommandNode {
  id: string;
  name: string;
  duration: number;
  /** 班组排程用人数（非负整数；缺省 0 兼容旧数据） */
  crew?: number;
  x: number;
  y: number;
}

interface CommandEdge {
  id: string;
  from: string;
  to: string;
  minDelay: number;
}

interface Project {
  nodes: CommandNode[];
  edges: CommandEdge[];
  /** 开场截止设置（可选，兼容旧数据） */
  deadline?: { enabled: boolean; seconds: number };
  /** 班组人数（正整数；缺省 1 兼容旧数据） */
  crewSize?: number;
}

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'project.json');
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', '..', 'client', 'dist');

/** 首次启动时的示例口令图（舞台换景流程）。 */
function seedProject(): Project {
  const node = (
    id: string,
    name: string,
    duration: number,
    x: number,
    y: number,
    crew = 0,
  ): CommandNode => ({ id, name, duration, crew, x, y });
  const edge = (id: string, from: string, to: string, minDelay: number): CommandEdge =>
    ({ id, from, to, minDelay });
  return {
    nodes: [
      node('n-curtain-down', '幕布落下', 3, 60, 220, 1),
      node('n-lights-dim', '灯光转暗', 2, 60, 340, 1),
      node('n-set-a-out', '布景A撤场', 8, 300, 160, 2),
      node('n-props-ready', '道具就位', 5, 300, 340, 1),
      node('n-set-b-in', '布景B上场', 10, 540, 160, 2),
      node('n-actors-ready', '演员就位', 4, 540, 340, 1),
      node('n-curtain-up', '幕布升起', 3, 780, 240, 1),
      node('n-lights-up', '灯光亮起', 2, 780, 360, 0),
    ],
    edges: [
      edge('e1', 'n-curtain-down', 'n-set-a-out', 1),
      edge('e2', 'n-curtain-down', 'n-props-ready', 0),
      edge('e3', 'n-lights-dim', 'n-set-a-out', 2),
      edge('e4', 'n-set-a-out', 'n-set-b-in', 2),
      edge('e5', 'n-set-b-in', 'n-actors-ready', 0),
      edge('e6', 'n-props-ready', 'n-actors-ready', 1),
      edge('e7', 'n-actors-ready', 'n-curtain-up', 1),
      edge('e8', 'n-curtain-up', 'n-lights-up', 0),
    ],
    // 示例流程最短工期为 34s，默认给出该值便于启用后直接看到关键链
    deadline: { enabled: false, seconds: 34 },
    // 班组 2 人：布景A撤场（2 人）期间道具就位需等其释放人手
    crewSize: 2,
  };
}

function isValidProject(p: unknown): p is Project {
  if (typeof p !== 'object' || p === null) return false;
  const proj = p as Project;
  if (!Array.isArray(proj.nodes) || !Array.isArray(proj.edges)) return false;

  // 班组人数：正整数；缺省（旧数据）按 1
  let crewSize = 1;
  if (proj.crewSize !== undefined) {
    if (
      typeof proj.crewSize !== 'number' ||
      !Number.isInteger(proj.crewSize) ||
      proj.crewSize < 1
    ) {
      return false;
    }
    crewSize = proj.crewSize;
  }

  const ids = new Set<string>();
  for (const n of proj.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string') return false;
    if (typeof n.duration !== 'number' || !isFinite(n.duration) || n.duration < 0) return false;
    if (typeof n.x !== 'number' || typeof n.y !== 'number') return false;
    // 用人数：非负整数，且不得超过班组人数；缺省（旧数据）按 0
    if (n.crew !== undefined) {
      if (typeof n.crew !== 'number' || !Number.isInteger(n.crew) || n.crew < 0 || n.crew > crewSize) {
        return false;
      }
    }
    if (ids.has(n.id)) return false;
    ids.add(n.id);
  }
  for (const e of proj.edges) {
    if (!e || typeof e.id !== 'string') return false;
    if (!ids.has(e.from) || !ids.has(e.to)) return false;
    if (typeof e.minDelay !== 'number' || !isFinite(e.minDelay) || e.minDelay < 0) return false;
  }
  if (proj.deadline !== undefined) {
    const d = proj.deadline;
    if (typeof d !== 'object' || d === null) return false;
    if (typeof d.enabled !== 'boolean') return false;
    if (typeof d.seconds !== 'number' || !isFinite(d.seconds) || d.seconds < 0) return false;
  }
  return true;
}

function ensureDataFile(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedProject(), null, 2), 'utf-8');
    console.log(`[server] seeded sample project at ${DATA_FILE}`);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/project', (_req: Request, res: Response) => {
  fs.readFile(DATA_FILE, 'utf-8', (err, data) => {
    if (err) {
      console.error('[server] read failed:', err.message);
      res.status(500).json({ error: 'failed to read project' });
      return;
    }
    res.type('application/json').send(data);
  });
});

app.put('/api/project', (req: Request, res: Response) => {
  if (!isValidProject(req.body)) {
    res.status(400).json({ error: 'invalid project payload' });
    return;
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(req.body, null, 2), 'utf-8', (err) => {
    if (err) {
      console.error('[server] write failed:', err.message);
      res.status(500).json({ error: 'failed to save project' });
      return;
    }
    fs.rename(tmp, DATA_FILE, (renameErr) => {
      if (renameErr) {
        console.error('[server] rename failed:', renameErr.message);
        res.status(500).json({ error: 'failed to save project' });
        return;
      }
      res.json({ ok: true, savedAt: new Date().toISOString() });
    });
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// 静态托管前端构建产物，其余路径回退到 index.html（SPA）。
app.use(express.static(CLIENT_DIST));
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('client not built');
    }
  });
});

ensureDataFile();
app.listen(PORT, () => {
  console.log(`[server] stage command sandbox listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] data file: ${DATA_FILE}`);
});
