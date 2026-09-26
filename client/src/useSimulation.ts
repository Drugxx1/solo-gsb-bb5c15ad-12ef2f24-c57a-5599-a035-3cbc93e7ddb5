import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeRuntime, Project, ScheduleResult, SimState } from './types';

const TICK_MS = 100;

export interface Simulation {
  state: SimState;
  time: number;
  runtime: Record<string, NodeRuntime>;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

/**
 * 按排程模拟执行口令。
 * - start/pause/resume/reset 控制时钟；
 * - 排程或口令图变化时，仅同步“尚未执行”的口令的排定时间，
 *   正在执行与已完成的口令保持其实际记录不变；
 * - 排定时间被改到过去且仍未执行的口令，会在下一拍立即补发。
 */
export function useSimulation(project: Project, schedule: ScheduleResult | null): Simulation {
  const [state, setState] = useState<SimState>('idle');
  const [time, setTime] = useState(0);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});

  const stateRef = useRef(state);
  stateRef.current = state;
  const timeRef = useRef(time);
  timeRef.current = time;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const projectRef = useRef(project);
  projectRef.current = project;

  // 口令图结构变化：移除已删除口令的运行记录，为新增口令补登记。
  useEffect(() => {
    if (stateRef.current === 'idle') return;
    setRuntime((prev) => {
      const next: Record<string, NodeRuntime> = {};
      for (const n of project.nodes) {
        next[n.id] = prev[n.id] ?? { status: 'pending' };
      }
      return next;
    });
  }, [project]);

  // 时钟：仅 running 时前进。
  useEffect(() => {
    if (state !== 'running') return;
    const timer = setInterval(() => {
      const now = timeRef.current + TICK_MS / 1000;
      const sched = scheduleRef.current;
      const proj = projectRef.current;

      setRuntime((prev) => {
        const next: Record<string, NodeRuntime> = { ...prev };
        let allDone = true;
        for (const n of proj.nodes) {
          const rt = next[n.id] ?? { status: 'pending' as const };
          if (rt.status === 'pending') {
            const scheduledStart = sched?.starts[n.id];
            if (scheduledStart !== undefined && scheduledStart <= now) {
              const actualStart = Math.max(scheduledStart, now);
              next[n.id] = {
                status: 'running',
                start: actualStart,
                end: actualStart + n.duration,
              };
              allDone = false;
            } else {
              next[n.id] = rt;
              allDone = false;
            }
          } else if (rt.status === 'running') {
            if (rt.end !== undefined && rt.end <= now) {
              next[n.id] = { ...rt, status: 'done' };
            } else {
              next[n.id] = rt;
              allDone = false;
            }
          }
        }
        if (allDone && proj.nodes.length > 0) {
          setState('finished');
        }
        return next;
      });
      timeRef.current = now;
      setTime(now);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [state]);

  const start = useCallback(() => {
    const initial: Record<string, NodeRuntime> = {};
    for (const n of projectRef.current.nodes) initial[n.id] = { status: 'pending' };
    setRuntime(initial);
    timeRef.current = 0;
    setTime(0);
    setState('running');
  }, []);

  const pause = useCallback(() => {
    if (stateRef.current === 'running') setState('paused');
  }, []);

  const resume = useCallback(() => {
    if (stateRef.current === 'paused') setState('running');
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    timeRef.current = 0;
    setTime(0);
    setRuntime({});
  }, []);

  return { state, time, runtime, start, pause, resume, reset };
}
