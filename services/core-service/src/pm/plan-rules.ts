/**
 * CD-177 วางแผนโครงการ — the plan's rules, apart from the database: the
 * work breakdown's numbering, which links may be drawn, and the dates that
 * follow from durations, links and the working calendar (with each task's
 * float, which CD-178 turns into the critical path on the timeline).
 */

export interface WorkCalendar {
  /** ISO weekdays that are working days (1 = Monday). */
  workingWeekdays: readonly number[];
  /** `YYYY-MM-DD` days the company is closed. */
  holidays: readonly string[];
}

export const DEFAULT_WORK_CALENDAR: WorkCalendar = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

export const MAX_DURATION_DAYS = 3650;
export const MAX_TASKS = 1000;

export interface PlanTask {
  id: string;
  parentId: string | null;
  seq: number;
  durationDays: number;
  status: string;
}

export interface PlanLink {
  predecessorId: string;
  successorId: string;
  lagDays: number;
}

const DAY_MS = 86_400_000;
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);
const nextDay = (day: string) =>
  toDay(new Date(toDate(day).getTime() + DAY_MS));

export function isWorkday(day: string, calendar: WorkCalendar): boolean {
  const weekday = toDate(day).getUTCDay() || 7;
  return (
    calendar.workingWeekdays.includes(weekday) &&
    !calendar.holidays.includes(day)
  );
}

/** Working days from `start` on, as many as asked (the calendar can be all holidays: stops at ten years). */
export function workdaysFrom(
  start: string,
  count: number,
  calendar: WorkCalendar,
): string[] {
  const out: string[] = [];
  let day = start;
  for (let guard = 0; out.length < count && guard < 3660 * 2; guard++) {
    if (isWorkday(day, calendar)) out.push(day);
    day = nextDay(day);
  }
  return out;
}

/** The live tasks, and which of them are summaries (have live children). */
function liveTree(tasks: readonly PlanTask[]) {
  const live = tasks.filter((task) => task.status !== 'cancelled');
  const ids = new Set(live.map((task) => task.id));
  const summaries = new Set(
    live
      .map((task) => task.parentId)
      .filter((id): id is string => Boolean(id) && ids.has(id!)),
  );
  return { live, ids, summaries };
}

/** "1", "1.2", "1.2.3" — by the order of siblings. */
export function wbsCodes(tasks: readonly PlanTask[]): Map<string, string> {
  const { live, ids } = liveTree(tasks);
  const codes = new Map<string, string>();
  const childrenOf = (parentId: string | null) =>
    live
      .filter(
        (task) =>
          (task.parentId && ids.has(task.parentId) ? task.parentId : null) ===
          parentId,
      )
      .sort((a, b) => a.seq - b.seq);
  const walk = (parentId: string | null, prefix: string) => {
    childrenOf(parentId).forEach((task, index) => {
      const code = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      codes.set(task.id, code);
      walk(task.id, code);
    });
  };
  walk(null, '');
  return codes;
}

/**
 * What is wrong with the links, in Thai: a link to or from a summary (its
 * dates come from its children), or links that go round in a circle.
 */
export function linkProblems(
  tasks: readonly PlanTask[],
  links: readonly PlanLink[],
  codes: Map<string, string> = wbsCodes(tasks),
): string[] {
  const { ids, summaries } = liveTree(tasks);
  const problems: string[] = [];
  const live = links.filter(
    (link) => ids.has(link.predecessorId) && ids.has(link.successorId),
  );
  for (const link of live) {
    for (const id of [link.predecessorId, link.successorId]) {
      if (summaries.has(id)) {
        problems.push(
          `งาน ${codes.get(id) ?? ''} มีงานย่อย — ผูกลำดับกับงานย่อยแทน`,
        );
      }
    }
  }
  if (topoOrder([...ids], live) === null) {
    problems.push('ลำดับงานวนเป็นวง — งานต้องเสร็จก่อนตัวเองไม่ได้');
  }
  return [...new Set(problems)];
}

/** Kahn's order of the tasks under the links, or null for a cycle. */
function topoOrder(
  ids: readonly string[],
  links: readonly PlanLink[],
): string[] | null {
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const link of links) {
    incoming.set(link.successorId, (incoming.get(link.successorId) ?? 0) + 1);
  }
  const queue = ids.filter((id) => !incoming.get(id));
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const link of links.filter((item) => item.predecessorId === id)) {
      const left = (incoming.get(link.successorId) ?? 0) - 1;
      incoming.set(link.successorId, left);
      if (left === 0) queue.push(link.successorId);
    }
  }
  return order.length === ids.length ? order : null;
}

export interface ScheduledTask {
  start: string;
  finish: string;
  /** Working days it can slip without moving the project's end. */
  floatDays: number;
  critical: boolean;
}

/**
 * The dates: every piece of work starts on the project's first working day
 * or the working day after its predecessors finish (plus their lag; after a
 * zero-day point in time, the same day), and lasts its working days. The
 * backward pass from the latest finish gives each its float; no float is
 * the critical path. Summaries span their children. Null when the links
 * cannot be scheduled (see {@link linkProblems}).
 */
export function schedulePlan(
  tasks: readonly PlanTask[],
  links: readonly PlanLink[],
  projectStart: string,
  calendar: WorkCalendar,
): { tasks: Map<string, ScheduledTask>; finish: string | null } | null {
  const { live, ids, summaries } = liveTree(tasks);
  const work = live.filter((task) => !summaries.has(task.id));
  const workIds = new Set(work.map((task) => task.id));
  const active = links.filter(
    (link) => workIds.has(link.predecessorId) && workIds.has(link.successorId),
  );
  if (
    links.some(
      (link) =>
        ids.has(link.predecessorId) && summaries.has(link.predecessorId),
    )
  ) {
    return null;
  }
  if (
    links.some(
      (link) => ids.has(link.successorId) && summaries.has(link.successorId),
    )
  ) {
    return null;
  }
  const order = topoOrder([...workIds], active);
  if (!order) return null;

  const duration = new Map(work.map((task) => [task.id, task.durationDays]));
  const span = (id: string) => Math.max(duration.get(id) ?? 1, 1) - 1;
  // gap after a predecessor: the next working day, or the same day after a
  // zero-day point in time
  const gap = (id: string) => ((duration.get(id) ?? 1) === 0 ? 0 : 1);

  // forward pass, in working-day indexes from the project's first working day
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const start = Math.max(
      0,
      ...active
        .filter((link) => link.successorId === id)
        .map(
          (link) =>
            ef.get(link.predecessorId)! +
            gap(link.predecessorId) +
            link.lagDays,
        ),
    );
    es.set(id, start);
    ef.set(id, start + span(id));
  }
  const end = order.length ? Math.max(...order.map((id) => ef.get(id)!)) : 0;

  // backward pass
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const after = active.filter((link) => link.predecessorId === id);
    const finish = after.length
      ? Math.min(
          ...after.map(
            (link) => ls.get(link.successorId)! - link.lagDays - gap(id),
          ),
        )
      : end;
    lf.set(id, finish);
    ls.set(id, finish - span(id));
  }

  const days = workdaysFrom(projectStart, end + 1, calendar);
  const dayAt = (index: number) => days[Math.min(index, days.length - 1)];
  const out = new Map<string, ScheduledTask>();
  for (const id of order) {
    const floatDays = ls.get(id)! - es.get(id)!;
    out.set(id, {
      start: dayAt(es.get(id)!),
      finish: dayAt(ef.get(id)!),
      floatDays,
      critical: floatDays === 0,
    });
  }
  // summaries span their children, deepest first
  const depth = (task: PlanTask): number => {
    let level = 0;
    let parent = task.parentId;
    while (parent && ids.has(parent) && level < 50) {
      level++;
      parent = live.find((item) => item.id === parent)?.parentId ?? null;
    }
    return level;
  };
  const summaryTasks = live
    .filter((task) => summaries.has(task.id))
    .sort((a, b) => depth(b) - depth(a));
  for (const summary of summaryTasks) {
    const children = live
      .filter((task) => task.parentId === summary.id)
      .map((task) => out.get(task.id))
      .filter((item): item is ScheduledTask => Boolean(item));
    if (!children.length) continue;
    const floatDays = Math.min(...children.map((item) => item.floatDays));
    out.set(summary.id, {
      start: children.map((item) => item.start).sort()[0],
      finish: children
        .map((item) => item.finish)
        .sort()
        .reverse()[0],
      floatDays,
      critical: children.some((item) => item.critical),
    });
  }
  return { tasks: out, finish: order.length ? dayAt(end) : null };
}

/** Would moving `taskId` under `parentId` put it under itself? */
export function wouldNest(
  tasks: readonly Pick<PlanTask, 'id' | 'parentId'>[],
  taskId: string,
  parentId: string | null,
): boolean {
  let current = parentId;
  for (let guard = 0; current && guard < 1000; guard++) {
    if (current === taskId) return true;
    current = tasks.find((task) => task.id === current)?.parentId ?? null;
  }
  return false;
}
