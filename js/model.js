export const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const cents = value => Math.round((Number(value) || 0) * 100);
export const yuan = value => (value / 100).toLocaleString("zh-CN", { minimumFractionDigits: value % 100 ? 2 : 0, maximumFractionDigits: 2 });
export const isoToday = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};
export const compareDate = (a, b) => a.localeCompare(b);
export const within = (date, start, end) => compareDate(date, start) >= 0 && compareDate(date, end) <= 0;
export const daysInclusive = (start, end) => {
  const a = new Date(`${start}T12:00:00`);
  const b = new Date(`${end}T12:00:00`);
  return Math.max(0, Math.round((b - a) / 86400000) + 1);
};
export const formatDate = value => {
  const [, m, d] = value.split("-");
  return `${Number(m)}月${Number(d)}日`;
};
export const cycleStatus = (cycle, today = isoToday()) => {
  if (cycle.archived) return "archived";
  if (compareDate(today, cycle.start) < 0) return "upcoming";
  if (compareDate(today, cycle.end) > 0) return "ended";
  return "active";
};

export function seedState() {
  const now = new Date().toISOString();
  const accountId = "acc_citic";
  const cycleId = "cy_daily";
  const seg1 = "seg_1";
  const seg2 = "seg_2";
  return {
    version: 1,
    accounts: [{ id: accountId, name: "中信信用卡", order: 0, archived: false, createdAt: now }],
    channels: [
      { id: "ch_food", accountId, name: "吃喝用", order: 0, archived: false, createdAt: now },
      { id: "ch_cat", accountId, name: "猫", order: 1, archived: false, createdAt: now },
      { id: "ch_sub", accountId, name: "月度订阅", order: 2, archived: false, createdAt: now },
      { id: "ch_fun", accountId, name: "玩乐", order: 3, archived: false, createdAt: now }
    ],
    cycles: [{
      id: cycleId, accountId, name: "日常开销", start: "2026-09-15", end: "2026-10-15", order: 0, archived: false, createdAt: now,
      segments: [
        { id: seg1, name: "第一分段", start: "2026-09-15", end: "2026-10-01", order: 0 },
        { id: seg2, name: "第二分段", start: "2026-10-02", end: "2026-10-15", order: 1 }
      ],
      allocations: [
        { channelId: "ch_food", totalBudget: 130000, segmented: true, segmentBudgets: { [seg1]: 65000, [seg2]: 65000 } },
        { channelId: "ch_cat", totalBudget: 80000, segmented: false, segmentBudgets: {} },
        { channelId: "ch_sub", totalBudget: 20000, segmented: false, segmentBudgets: {} },
        { channelId: "ch_fun", totalBudget: 30000, segmented: true, segmentBudgets: { [seg1]: 10000, [seg2]: 20000 } }
      ]
    }],
    transactions: [
      { id: "tx_1", cycleId, channelId: "ch_food", type: "expense", amount: 35000, date: "2026-09-20", createdAt: now },
      { id: "tx_2", cycleId, channelId: "ch_cat", type: "expense", amount: 28000, date: "2026-09-21", createdAt: now },
      { id: "tx_3", cycleId, channelId: "ch_sub", type: "expense", amount: 13000, date: "2026-09-16", createdAt: now },
      { id: "tx_4", cycleId, channelId: "ch_fun", type: "expense", amount: 4000, date: "2026-09-24", createdAt: now }
    ],
    settlements: [],
    budgetChanges: []
  };
}

export const accountById = (state, id) => state.accounts.find(item => item.id === id);
export const channelById = (state, id) => state.channels.find(item => item.id === id);
export const cycleById = (state, id) => state.cycles.find(item => item.id === id);
export const sortedAccounts = state => [...state.accounts].sort((a, b) => a.order - b.order);
export const sortedChannels = (state, accountId) => state.channels.filter(item => item.accountId === accountId).sort((a, b) => a.order - b.order);

export function netTransactions(state, cycleId, channelId, start, end) {
  return state.transactions
    .filter(tx => tx.cycleId === cycleId && tx.channelId === channelId && (!start || within(tx.date, start, end)))
    .reduce((sum, tx) => sum + (tx.type === "refund" ? -tx.amount : tx.amount), 0);
}

export function incomingCycleAdjustment(state, cycle, channelId) {
  return state.settlements
    .filter(s => s.scope === "cycle" && s.targetCycleId === cycle.id && s.channelId === channelId)
    .reduce((sum, s) => sum + (s.decision === "carry" ? s.amount : s.decision === "deduct" ? -s.amount : 0), 0);
}

export function segmentBudget(state, cycle, allocation, segment) {
  let budget = allocation.segmentBudgets[segment.id] || 0;
  const segments = [...cycle.segments].sort((a, b) => a.order - b.order);
  const index = segments.findIndex(item => item.id === segment.id);
  if (index === 0) budget += incomingCycleAdjustment(state, cycle, allocation.channelId);
  if (index > 0) {
    const previous = segments[index - 1];
    const settlement = state.settlements.find(s => s.scope === "segment" && s.cycleId === cycle.id && s.channelId === allocation.channelId && s.segmentId === previous.id);
    if (settlement?.decision === "carry") budget += settlement.amount;
    if (settlement?.decision === "deduct") budget -= settlement.amount;
  }
  return budget;
}

export function activeSegment(cycle, date = isoToday()) {
  return [...cycle.segments].sort((a, b) => a.order - b.order).find(seg => within(date, seg.start, seg.end)) || null;
}

export function channelSnapshot(state, cycle, allocation, today = isoToday()) {
  const totalSpent = netTransactions(state, cycle.id, allocation.channelId);
  if (!allocation.segmented || !cycle.segments.length) {
    const effectiveBudget = allocation.totalBudget + incomingCycleAdjustment(state, cycle, allocation.channelId);
    const remaining = effectiveBudget - totalSpent;
    const dayStart = compareDate(today, cycle.start) < 0 ? cycle.start : today;
    const days = within(dayStart, cycle.start, cycle.end) ? daysInclusive(dayStart, cycle.end) : 0;
    return { scope: "cycle", remaining, totalSpent, effectiveBudget, days, daily: days > 0 ? Math.max(0, remaining) / days : 0, segment: null };
  }
  const segment = activeSegment(cycle, today) || (compareDate(today, cycle.start) < 0 ? [...cycle.segments].sort((a,b) => a.order-b.order)[0] : null);
  if (!segment) return { scope: "segment", remaining: allocation.totalBudget - totalSpent, totalSpent, effectiveBudget: allocation.totalBudget, days: 0, daily: 0, segment: null };
  const budget = segmentBudget(state, cycle, allocation, segment);
  const spent = netTransactions(state, cycle.id, allocation.channelId, segment.start, segment.end);
  const remaining = budget - spent;
  const dayStart = compareDate(today, segment.start) < 0 ? segment.start : today;
  const days = within(dayStart, segment.start, segment.end) ? daysInclusive(dayStart, segment.end) : 0;
  return { scope: "segment", remaining, totalSpent, effectiveBudget: budget, days, daily: days > 0 ? Math.max(0, remaining) / days : 0, segment };
}

export function spendableRemaining(state, cycle, allocation, today = isoToday()) {
  if (cycleStatus(cycle, today) !== "active") return 0;
  if (!allocation.segmented || !cycle.segments.length) return channelSnapshot(state, cycle, allocation, today).remaining;
  return [...cycle.segments].sort((a,b) => a.order-b.order).reduce((sum, segment) => {
    if (compareDate(segment.end, today) < 0) return sum;
    const budget = segmentBudget(state, cycle, allocation, segment);
    const spent = netTransactions(state, cycle.id, allocation.channelId, segment.start, segment.end);
    return sum + budget - spent;
  }, 0);
}

export function eligibleContexts(state, date) {
  const results = [];
  for (const cycle of state.cycles) {
    const account = accountById(state, cycle.accountId);
    if (cycle.archived || account?.archived || !within(date, cycle.start, cycle.end)) continue;
    for (const allocation of cycle.allocations) {
      const channel = channelById(state, allocation.channelId);
      if (!channel || channel.archived) continue;
      results.push({ cycle, channel, account, allocation });
    }
  }
  return results.sort((a, b) => a.account.order - b.account.order || a.channel.order - b.channel.order);
}

export function pendingSettlements(state, today = isoToday()) {
  const pending = [];
  for (const cycle of state.cycles.filter(item => !item.archived)) {
    const segments = [...cycle.segments].sort((a, b) => a.order - b.order);
    for (const allocation of cycle.allocations.filter(item => item.segmented)) {
      segments.slice(0, -1).forEach((segment, index) => {
        if (compareDate(segment.end, today) >= 0) return;
        const budget = segmentBudget(state, cycle, allocation, segment);
        const actual = netTransactions(state, cycle.id, allocation.channelId, segment.start, segment.end);
        const difference = budget - actual;
        if (difference === 0) return;
        const existing = state.settlements.find(s => s.scope === "segment" && s.cycleId === cycle.id && s.channelId === allocation.channelId && s.segmentId === segment.id && s.basisBudget === budget && s.basisActual === actual);
        if (!existing) pending.push({ scope: "segment", cycle, allocation, segment, nextSegment: segments[index + 1], amount: Math.abs(difference), kind: difference > 0 ? "surplus" : "overspend", budget, actual });
      });
    }
    if (cycleStatus(cycle, today) === "ended") {
      for (const allocation of cycle.allocations) {
        if (pending.some(item => item.scope === "segment" && item.cycle.id === cycle.id && item.allocation.channelId === allocation.channelId)) continue;
        const budget = allocation.totalBudget + incomingCycleAdjustment(state, cycle, allocation.channelId);
        const actual = netTransactions(state, cycle.id, allocation.channelId);
        const difference = budget - actual;
        if (difference === 0) continue;
        const existing = state.settlements.find(s => s.scope === "cycle" && s.cycleId === cycle.id && s.channelId === allocation.channelId && s.basisBudget === budget && s.basisActual === actual);
        if (!existing) pending.push({ scope: "cycle", cycle, allocation, amount: Math.abs(difference), kind: difference > 0 ? "surplus" : "overspend", budget, actual });
      }
    }
  }
  return pending;
}

export function nextCycleForChannel(state, cycle, channelId) {
  return state.cycles
    .filter(item => !item.archived && item.id !== cycle.id && compareDate(item.start, cycle.end) > 0 && item.allocations.some(a => a.channelId === channelId))
    .sort((a, b) => compareDate(a.start, b.start))[0] || null;
}
