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

export function createInitialState() {
  return {
    version: 2,
    accounts: [],
    channels: [],
    cycles: [],
    transactions: [],
    settlements: [],
    budgetChanges: []
  };
}

export function isUntouchedLegacySample(state) {
  if (!state || state.version !== 1) return false;
  const exactIds = (items, ids) => items?.length === ids.length && ids.every(id => items.some(item => item.id === id));
  const account = state.accounts?.find(item => item.id === "acc_citic");
  const cycle = state.cycles?.find(item => item.id === "cy_daily");
  const expectedChannels = { ch_food: "吃喝用", ch_cat: "猫", ch_sub: "月度订阅", ch_fun: "玩乐" };
  const expectedTransactions = {
    tx_1: ["ch_food", 35000, "2026-09-20"],
    tx_2: ["ch_cat", 28000, "2026-09-21"],
    tx_3: ["ch_sub", 13000, "2026-09-16"],
    tx_4: ["ch_fun", 4000, "2026-09-24"]
  };
  const expectedBudgets = { ch_food: 130000, ch_cat: 80000, ch_sub: 20000, ch_fun: 30000 };
  return exactIds(state.accounts, ["acc_citic"])
    && exactIds(state.channels, ["ch_food", "ch_cat", "ch_sub", "ch_fun"])
    && exactIds(state.cycles, ["cy_daily"])
    && exactIds(state.transactions, ["tx_1", "tx_2", "tx_3", "tx_4"])
    && account?.name === "中信信用卡" && account.archived === false
    && cycle?.name === "日常开销" && cycle.start === "2026-09-15" && cycle.end === "2026-10-15" && cycle.archived === false
    && exactIds(cycle?.segments, ["seg_1", "seg_2"])
    && cycle.segments.find(item => item.id === "seg_1")?.start === "2026-09-15"
    && cycle.segments.find(item => item.id === "seg_1")?.end === "2026-10-01"
    && cycle.segments.find(item => item.id === "seg_2")?.start === "2026-10-02"
    && cycle.segments.find(item => item.id === "seg_2")?.end === "2026-10-15"
    && cycle.allocations?.length === 4
    && Object.entries(expectedBudgets).every(([channelId, budget]) => cycle.allocations.find(item => item.channelId === channelId)?.totalBudget === budget)
    && cycle.allocations.find(item => item.channelId === "ch_food")?.segmented === true
    && cycle.allocations.find(item => item.channelId === "ch_food")?.segmentBudgets?.seg_1 === 65000
    && cycle.allocations.find(item => item.channelId === "ch_food")?.segmentBudgets?.seg_2 === 65000
    && cycle.allocations.find(item => item.channelId === "ch_fun")?.segmented === true
    && cycle.allocations.find(item => item.channelId === "ch_fun")?.segmentBudgets?.seg_1 === 10000
    && cycle.allocations.find(item => item.channelId === "ch_fun")?.segmentBudgets?.seg_2 === 20000
    && Object.entries(expectedChannels).every(([id, name]) => {
      const channel = state.channels.find(item => item.id === id);
      return channel?.name === name && channel.accountId === "acc_citic" && channel.archived === false;
    })
    && Object.entries(expectedTransactions).every(([id, [channelId, amount, date]]) => {
      const transaction = state.transactions.find(item => item.id === id);
      return transaction?.channelId === channelId && transaction.amount === amount && transaction.date === date && transaction.type === "expense";
    })
    && !(state.settlements?.length)
    && !(state.budgetChanges?.length);
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
