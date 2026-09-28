import { loadState, saveState, resetState } from "./db.js";
import {
  uid, cents, yuan, isoToday, compareDate, within, daysInclusive, formatDate, cycleStatus,
  seedState, accountById, channelById, cycleById, sortedAccounts, sortedChannels,
  netTransactions, incomingCycleAdjustment, channelSnapshot, spendableRemaining,
  eligibleContexts, pendingSettlements, nextCycleForChannel
} from "./model.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#app-dialog");
const dialogContent = document.querySelector("#dialog-content");
const toast = document.querySelector("#toast");
let state;
let currentView = "home";
let toastTimer;

const h = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const money = value => `${value < 0 ? "-" : ""}¥${yuan(Math.abs(value))}`;
const nowLabel = () => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
const statusLabel = status => ({ active: "进行中", upcoming: "即将开始", ended: "已结束", archived: "已归档" })[status];
const today = () => isoToday();

async function persist(message) {
  await saveState(state);
  render();
  if (message) showToast(message);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function openDialog(content) {
  dialogContent.innerHTML = content;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  dialogContent.innerHTML = "";
}

function header(title, subtitle = "") {
  const pending = pendingSettlements(state).length;
  return `<header class="topbar"><div><h1>${h(title)}</h1>${subtitle ? `<p>${h(subtitle)}</p>` : ""}</div>
    <button class="icon-button notification-button" type="button" data-action="notifications" aria-label="结转通知">
      <span aria-hidden="true">◌</span>${pending ? `<b>${pending}</b>` : ""}
    </button></header>`;
}

function nav() {
  return `<nav class="bottom-nav" aria-label="主要导航">
    <button class="nav-item ${currentView === "home" ? "active" : ""}" data-view="home" type="button"><span>⌂</span>首页</button>
    <button class="nav-item ${currentView === "records" ? "active" : ""}" data-view="records" type="button"><span>≡</span>记录</button>
    <button class="nav-item ${currentView === "manage" ? "active" : ""}" data-view="manage" type="button"><span>⚙</span>管理</button>
  </nav>`;
}

function render() {
  const content = currentView === "home" ? renderHome() : currentView === "records" ? renderRecords() : renderManage();
  app.innerHTML = `<main class="app-shell">${content}</main>
    ${currentView !== "manage" ? `<button class="fab" type="button" data-action="add-record" aria-label="新增支出或退款">＋</button>` : ""}${nav()}`;
}

function renderHome() {
  const accounts = sortedAccounts(state).filter(item => !item.archived);
  const accountCards = accounts.map(renderAccount).join("");
  return `${header("额度看板", `${nowLabel()} · 只看还能花多少`)}
    <section class="notice-strip ${pendingSettlements(state).length ? "" : "hidden"}" data-action="notifications">
      <div><strong>${pendingSettlements(state).length}项结转待确认</strong><span>处理后额度会自动更新</span></div><span>›</span>
    </section>
    ${accountCards || emptyState("还没有账户", "先到管理页建立账户和开销渠道。")}`;
}

function cycleOrderValue(cycle) {
  const status = cycleStatus(cycle);
  return status === "active" ? 0 : status === "upcoming" ? 1 : 2;
}

function renderAccount(account) {
  const cycles = state.cycles.filter(item => item.accountId === account.id && !item.archived)
    .sort((a, b) => cycleOrderValue(a) - cycleOrderValue(b) || (cycleOrderValue(a) < 2 ? a.order - b.order : compareDate(b.end, a.end)));
  const activeCycles = cycles.filter(item => cycleStatus(item) === "active");
  const totalBudget = activeCycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + allocation.totalBudget + incomingCycleAdjustment(state, cycle, allocation.channelId), 0), 0);
  const spent = activeCycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + netTransactions(state, cycle.id, allocation.channelId), 0), 0);
  const remaining = activeCycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + spendableRemaining(state, cycle, allocation), 0), 0);
  return `<section class="account-card" aria-labelledby="account-${account.id}">
    <div class="account-summary">
      <div class="account-heading"><h2 id="account-${account.id}">${h(account.name)}</h2><span>${activeCycles.length}个进行中周期</span></div>
      <p class="eyebrow">剩余总额度</p><p class="balance ${remaining < 0 ? "negative" : ""}">${money(remaining)}</p>
      <div class="summary-grid"><div><small>总预算</small><strong>${money(totalBudget)}</strong></div><div><small>实际支出</small><strong>${money(spent)}</strong></div></div>
    </div>
    ${cycles.length ? cycles.map(renderCycle).join("") : `<div class="inline-empty">暂无进行中或待归档周期</div>`}
  </section>`;
}

function renderCycle(cycle) {
  const status = cycleStatus(cycle);
  const spent = cycle.allocations.reduce((sum, allocation) => sum + netTransactions(state, cycle.id, allocation.channelId), 0);
  const total = cycle.allocations.reduce((sum, allocation) => sum + allocation.totalBudget + incomingCycleAdjustment(state, cycle, allocation.channelId), 0);
  const allocations = [...cycle.allocations].sort((a, b) => (channelById(state, a.channelId)?.order ?? 0) - (channelById(state, b.channelId)?.order ?? 0));
  return `<div class="cycle ${status === "ended" ? "ended-cycle" : ""}">
    <div class="cycle-header"><div><h3>${h(cycle.name)}</h3><p>${formatDate(cycle.start)}—${formatDate(cycle.end)}${status === "active" ? currentSegmentText(cycle) : ""}</p></div><span class="status ${status}">${statusLabel(status)}</span></div>
    ${status === "ended" ? `<div class="cycle-result"><span>预算 ${money(total)}</span><span>实际 ${money(spent)}</span></div>` : ""}
    <div class="channel-list">${allocations.map(allocation => renderChannel(cycle, allocation, status)).join("")}</div>
    ${status === "ended" ? `<div class="cycle-actions"><button class="secondary-button" data-action="cycle-details" data-cycle-id="${cycle.id}" type="button">查看详情</button><button class="primary-button compact" data-action="archive-cycle" data-cycle-id="${cycle.id}" type="button">归档</button></div>` : ""}
  </div>`;
}

function currentSegmentText(cycle) {
  const segment = cycle.segments.find(item => within(today(), item.start, item.end));
  return segment ? ` · ${h(segment.name)}` : "";
}

function renderChannel(cycle, allocation, status) {
  const channel = channelById(state, allocation.channelId);
  if (!channel) return "";
  const snapshot = channelSnapshot(state, cycle, allocation);
  const remaining = status === "active" || status === "upcoming" ? snapshot.remaining : allocation.totalBudget - snapshot.totalSpent;
  const ratio = snapshot.effectiveBudget > 0 ? Math.max(0, Math.min(100, remaining / snapshot.effectiveBudget * 100)) : 0;
  const scopeLabel = allocation.segmented && snapshot.segment ? `${h(snapshot.segment.name)}预算 ${money(snapshot.effectiveBudget)}` : `整体预算 ${money(snapshot.effectiveBudget)}`;
  return `<button class="channel-row" data-action="channel-detail" data-cycle-id="${cycle.id}" data-channel-id="${channel.id}" type="button">
    <span class="channel-main"><span class="channel-title">${h(channel.name)}${allocation.segmented ? `<em>分段</em>` : ""}</span>
      <span class="channel-meta">${status === "active" ? `剩余${snapshot.days}天 · ` : ""}${scopeLabel}</span><span class="progress" style="--progress:${ratio}%"><i></i></span></span>
    <span class="channel-numbers"><strong class="${remaining < 0 ? "danger-text" : ""}">${money(remaining)}</strong>
      ${status === "active" ? `<span>${remaining < 0 ? `已超支 ${money(-remaining)}` : `每天 ${money(snapshot.daily)}`}</span>` : `<span>实际 ${money(snapshot.totalSpent)}</span>`}</span>
  </button>`;
}

function renderRecords() {
  const transactions = [...state.transactions].sort((a, b) => compareDate(b.date, a.date) || b.createdAt.localeCompare(a.createdAt));
  return `${header("支出记录", "只记录类型、渠道、金额和日期")}
    <section class="records-panel">${transactions.length ? transactions.map(renderTransaction).join("") : emptyState("还没有记录", "点击右下角加号记一笔。")}</section>`;
}

function renderTransaction(tx) {
  const channel = channelById(state, tx.channelId);
  const cycle = cycleById(state, tx.cycleId);
  const account = cycle ? accountById(state, cycle.accountId) : null;
  return `<article class="record-row">
    <div class="record-date"><strong>${tx.date.slice(8)}</strong><span>${Number(tx.date.slice(5, 7))}月</span></div>
    <div class="record-info"><strong>${h(channel?.name || "已归档渠道")}</strong><span>${h(account?.name || "未知账户")} · ${h(cycle?.name || "未知周期")}</span></div>
    <div class="record-amount ${tx.type}"><strong>${tx.type === "refund" ? "+" : "-"}${money(tx.amount)}</strong><span>${tx.type === "refund" ? "退款" : "支出"}</span></div>
    <button class="more-button" data-action="edit-record" data-id="${tx.id}" aria-label="编辑记录" type="button">•••</button>
  </article>`;
}

function renderManage() {
  const accounts = sortedAccounts(state);
  return `${header("统一管理", "账户、渠道和预算周期")}
    <section class="manage-section"><div class="section-heading"><div><h2>账户</h2><p>排序决定首页分组顺序</p></div><button class="small-add" data-action="add-account" type="button">＋ 新建</button></div>
      <div class="manage-list">${accounts.map((account, index) => renderManageAccount(account, index, accounts.length)).join("") || emptyState("暂无账户", "新建一个账户开始。")}</div></section>
    <section class="manage-section"><div class="section-heading"><div><h2>开销渠道</h2><p>渠道固定归属一个账户</p></div><button class="small-add" data-action="add-channel" type="button">＋ 新建</button></div>
      ${accounts.map(account => renderManageChannels(account)).join("")}</section>
    <section class="manage-section"><div class="section-heading"><div><h2>预算周期</h2><p>同一渠道不能进入重叠周期</p></div><button class="small-add" data-action="add-cycle" type="button">＋ 新建</button></div>
      <div class="manage-list">${state.cycles.slice().sort((a,b) => compareDate(b.start,a.start)).map(renderManageCycle).join("") || emptyState("暂无周期", "创建周期并为渠道分配预算。")}</div></section>
    <section class="manage-section"><div class="section-heading"><div><h2>本地数据</h2><p>数据只保存在这台设备</p></div></div>
      <div class="data-actions"><button class="secondary-button" data-action="export" type="button">导出备份</button><label class="secondary-button file-button">导入备份<input id="import-file" type="file" accept="application/json"></label><button class="text-danger" data-action="reset" type="button">恢复示例数据</button></div></section>`;
}

function renderManageAccount(account, index, total) {
  const linked = state.cycles.some(cycle => cycle.accountId === account.id && !cycle.archived);
  return `<article class="manage-row ${account.archived ? "archived" : ""}"><div><strong>${h(account.name)}</strong><span>${account.archived ? "已归档 · 只读" : "可用"}</span></div>
    <div class="row-actions">${!account.archived ? `<button data-action="move-account" data-id="${account.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} type="button">↑</button><button data-action="move-account" data-id="${account.id}" data-direction="1" ${index === total - 1 ? "disabled" : ""} type="button">↓</button><button data-action="edit-account" data-id="${account.id}" type="button">编辑</button>` : ""}<button data-action="toggle-account" data-id="${account.id}" data-linked="${linked}" type="button">${account.archived ? "恢复" : "归档"}</button></div></article>`;
}

function renderManageChannels(account) {
  const channels = sortedChannels(state, account.id);
  if (!channels.length) return "";
  return `<div class="manage-group"><h3>${h(account.name)}${account.archived ? " · 已归档" : ""}</h3><div class="manage-list">${channels.map((channel, index) => {
    const used = state.cycles.some(cycle => !cycle.archived && cycle.allocations.some(a => a.channelId === channel.id));
    return `<article class="manage-row ${channel.archived ? "archived" : ""}"><div><strong>${h(channel.name)}</strong><span>${channel.archived ? "已归档 · 只读" : "可用"}</span></div><div class="row-actions">${!channel.archived ? `<button data-action="move-channel" data-id="${channel.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} type="button">↑</button><button data-action="move-channel" data-id="${channel.id}" data-direction="1" ${index === channels.length - 1 ? "disabled" : ""} type="button">↓</button><button data-action="edit-channel" data-id="${channel.id}" type="button">编辑</button>` : ""}<button data-action="toggle-channel" data-id="${channel.id}" data-used="${used}" type="button">${channel.archived ? "恢复" : "归档"}</button></div></article>`;
  }).join("")}</div></div>`;
}

function renderManageCycle(cycle) {
  const account = accountById(state, cycle.accountId);
  const status = cycleStatus(cycle);
  return `<article class="manage-row ${cycle.archived ? "archived" : ""}"><div><strong>${h(cycle.name)}</strong><span>${h(account?.name)} · ${formatDate(cycle.start)}—${formatDate(cycle.end)} · ${statusLabel(status)}</span></div><div class="row-actions">${status === "active" ? `<button data-action="move-cycle" data-id="${cycle.id}" data-direction="-1" type="button">↑</button><button data-action="move-cycle" data-id="${cycle.id}" data-direction="1" type="button">↓</button>` : ""}${cycle.archived ? `<button data-action="restore-cycle" data-id="${cycle.id}" type="button">恢复</button>` : status === "ended" ? `<button data-action="archive-cycle" data-cycle-id="${cycle.id}" type="button">归档</button>` : ""}</div></article>`;
}

function emptyState(title, text) {
  return `<div class="empty-state"><strong>${h(title)}</strong><span>${h(text)}</span></div>`;
}

function openRecordDialog(existing = null) {
  const initialDate = existing?.date || today();
  const contexts = eligibleContexts(state, initialDate);
  openDialog(`<form id="record-form" class="dialog-card">
    <div class="dialog-head"><div><p class="dialog-kicker">快速记录</p><h2 id="dialog-title">${existing ? "修改记录" : "记一笔"}</h2></div><button class="dialog-close" data-action="close-dialog" type="button">×</button></div>
    <input type="hidden" name="id" value="${existing?.id || ""}">
    <div class="type-switch"><label><input type="radio" name="type" value="expense" ${!existing || existing.type === "expense" ? "checked" : ""}><span>支出</span></label><label><input type="radio" name="type" value="refund" ${existing?.type === "refund" ? "checked" : ""}><span>退款</span></label></div>
    <label class="field amount-field"><span>金额</span><div><b>¥</b><input name="amount" inputmode="decimal" min="0.01" step="0.01" value="${existing ? existing.amount / 100 : ""}" placeholder="0.00" required></div></label>
    <label class="field"><span>日期</span><input id="record-date" name="date" type="date" value="${initialDate}" required></label>
    <label class="field"><span>开销渠道</span><select id="record-context" name="context" required>${contextOptions(contexts, existing)}</select></label>
    <p id="record-empty" class="form-note ${contexts.length ? "hidden" : ""}">这一天没有可用的渠道预算，请先创建周期。</p>
    <div class="dialog-actions">${existing ? `<button class="text-danger" data-action="delete-record" data-id="${existing.id}" type="button">删除</button>` : `<span></span>`}<button class="primary-button" ${contexts.length ? "" : "disabled"} type="submit">保存</button></div>
  </form>`);
  const dateInput = dialogContent.querySelector("#record-date");
  dateInput.addEventListener("change", () => refreshRecordContexts(dateInput.value, existing));
}

function contextOptions(contexts, existing) {
  if (!contexts.length) return `<option value="">无可用渠道</option>`;
  return contexts.map(({ account, cycle, channel }) => {
    const value = `${cycle.id}|${channel.id}`;
    const selected = existing && existing.cycleId === cycle.id && existing.channelId === channel.id ? "selected" : "";
    return `<option value="${value}" ${selected}>${h(account.name)} · ${h(cycle.name)} · ${h(channel.name)}</option>`;
  }).join("");
}

function refreshRecordContexts(date, existing) {
  const contexts = eligibleContexts(state, date);
  const select = dialogContent.querySelector("#record-context");
  select.innerHTML = contextOptions(contexts, existing);
  dialogContent.querySelector("#record-empty").classList.toggle("hidden", contexts.length > 0);
  dialogContent.querySelector("button[type=submit]").disabled = !contexts.length;
}

function invalidateSettlements(cycleId, channelId) {
  state.settlements = state.settlements.filter(item => !(item.cycleId === cycleId && item.channelId === channelId));
}

function openEntityDialog(kind, existing = null) {
  const isAccount = kind === "account";
  const accounts = sortedAccounts(state).filter(item => !item.archived);
  openDialog(`<form id="entity-form" class="dialog-card" data-kind="${kind}">
    <div class="dialog-head"><div><p class="dialog-kicker">统一管理</p><h2 id="dialog-title">${existing ? "修改" : "新建"}${isAccount ? "账户" : "开销渠道"}</h2></div><button class="dialog-close" data-action="close-dialog" type="button">×</button></div>
    <input type="hidden" name="id" value="${existing?.id || ""}">
    <label class="field"><span>${isAccount ? "账户名称" : "渠道名称"}</span><input name="name" value="${h(existing?.name || "")}" maxlength="30" required></label>
    ${isAccount ? "" : `<label class="field"><span>所属账户</span><select name="accountId" ${existing && state.cycles.some(c => c.allocations.some(a => a.channelId === existing.id)) ? "disabled" : ""}>${accounts.map(account => `<option value="${account.id}" ${existing?.accountId === account.id ? "selected" : ""}>${h(account.name)}</option>`).join("")}</select></label>`}
    <div class="dialog-actions"><span></span><button class="primary-button" type="submit">保存</button></div>
  </form>`);
}

let cycleDraft = null;
function openCycleDialog() {
  const accounts = sortedAccounts(state).filter(item => !item.archived);
  if (!accounts.length) return showToast("请先创建可用账户");
  cycleDraft = { accountId: accounts[0].id, name: "", start: today(), end: today(), segments: [], selected: {} };
  renderCycleDialog();
}

function renderCycleDialog() {
  const accounts = sortedAccounts(state).filter(item => !item.archived);
  const channels = sortedChannels(state, cycleDraft.accountId).filter(item => !item.archived);
  openDialog(`<form id="cycle-form" class="dialog-card wide-dialog">
    <div class="dialog-head"><div><p class="dialog-kicker">预算设置</p><h2 id="dialog-title">新建预算周期</h2></div><button class="dialog-close" data-action="close-dialog" type="button">×</button></div>
    <div class="form-grid"><label class="field"><span>所属账户</span><select name="accountId">${accounts.map(account => `<option value="${account.id}" ${cycleDraft.accountId === account.id ? "selected" : ""}>${h(account.name)}</option>`).join("")}</select></label>
    <label class="field"><span>周期名称</span><input name="name" value="${h(cycleDraft.name)}" maxlength="30" placeholder="例如：日常开销" required></label>
    <label class="field"><span>开始日期</span><input name="start" type="date" value="${cycleDraft.start}" required></label>
    <label class="field"><span>结束日期</span><input name="end" type="date" value="${cycleDraft.end}" required></label></div>
    <div class="form-section"><div class="subheading"><div><strong>统一分段</strong><span>选择分段的渠道都会使用这些日期</span></div><button class="small-add" data-action="add-segment" type="button">＋ 分段</button></div>
      <div id="segment-fields">${cycleDraft.segments.length ? cycleDraft.segments.map((segment, index) => `<div class="segment-edit"><input data-segment-index="${index}" data-key="name" value="${h(segment.name)}" aria-label="分段名称"><input data-segment-index="${index}" data-key="start" type="date" value="${segment.start}" aria-label="开始日期"><input data-segment-index="${index}" data-key="end" type="date" value="${segment.end}" aria-label="结束日期"><button data-action="remove-segment" data-index="${index}" type="button">×</button></div>`).join("") : `<p class="form-note">不需要分段可以留空。</p>`}</div>
    </div>
    <div class="form-section"><div class="subheading"><div><strong>渠道预算</strong><span>至少选择一个渠道</span></div></div>
      <div class="allocation-list">${channels.length ? channels.map(channel => renderAllocationDraft(channel)).join("") : `<p class="form-note">该账户还没有可用渠道。</p>`}</div>
    </div>
    <p id="cycle-error" class="form-error hidden"></p>
    <div class="dialog-actions"><span></span><button class="primary-button" type="submit">创建周期</button></div>
  </form>`);
}

function renderAllocationDraft(channel) {
  const draft = cycleDraft.selected[channel.id] || { enabled: false, total: "", segmented: false, segmentValues: [] };
  const overlap = state.cycles.some(cycle => cycle.allocations.some(a => a.channelId === channel.id) && !(compareDate(cycle.end, cycleDraft.start) < 0 || compareDate(cycle.start, cycleDraft.end) > 0));
  return `<div class="allocation-edit ${draft.enabled ? "selected" : ""} ${overlap ? "disabled" : ""}">
    <label class="allocation-toggle"><input type="checkbox" data-channel-id="${channel.id}" data-key="enabled" ${draft.enabled ? "checked" : ""} ${overlap ? "disabled" : ""}><span><strong>${h(channel.name)}</strong>${overlap ? `<small>与已有周期重叠</small>` : ""}</span></label>
    ${draft.enabled ? `<label class="mini-field"><span>总预算</span><input inputmode="decimal" data-channel-id="${channel.id}" data-key="total" value="${h(draft.total)}" placeholder="0" required></label>
      ${cycleDraft.segments.length > 1 ? `<label class="inline-check"><input type="checkbox" data-channel-id="${channel.id}" data-key="segmented" ${draft.segmented ? "checked" : ""}>按分段分配</label>` : ""}
      ${draft.segmented ? `<div class="segment-budget-list">${cycleDraft.segments.map((segment, index) => `<label><span>${h(segment.name)}</span><input inputmode="decimal" data-channel-id="${channel.id}" data-segment-budget="${index}" value="${h(draft.segmentValues[index] || "")}" placeholder="0"></label>`).join("")}</div>` : ""}` : ""}
  </div>`;
}

function syncCycleDraftFromForm() {
  const form = dialogContent.querySelector("#cycle-form");
  if (!form) return;
  cycleDraft.accountId = form.elements.accountId.value;
  cycleDraft.name = form.elements.name.value;
  cycleDraft.start = form.elements.start.value;
  cycleDraft.end = form.elements.end.value;
  dialogContent.querySelectorAll("[data-segment-index]").forEach(input => {
    const segment = cycleDraft.segments[Number(input.dataset.segmentIndex)];
    if (segment) segment[input.dataset.key] = input.value;
  });
  dialogContent.querySelectorAll("[data-channel-id]").forEach(input => {
    const id = input.dataset.channelId;
    const draft = cycleDraft.selected[id] || (cycleDraft.selected[id] = { enabled: false, total: "", segmented: false, segmentValues: [] });
    if (input.dataset.key === "enabled" || input.dataset.key === "segmented") draft[input.dataset.key] = input.checked;
    if (input.dataset.key === "total") draft.total = input.value;
    if (input.dataset.segmentBudget !== undefined) draft.segmentValues[Number(input.dataset.segmentBudget)] = input.value;
  });
}

function validateCycleDraft() {
  if (!cycleDraft.name.trim()) return "请填写周期名称";
  if (compareDate(cycleDraft.start, cycleDraft.end) > 0) return "结束日期不能早于开始日期";
  const selected = Object.entries(cycleDraft.selected).filter(([, value]) => value.enabled);
  if (!selected.length) return "至少选择一个开销渠道";
  if (cycleDraft.segments.length) {
    const segments = [...cycleDraft.segments].sort((a,b) => compareDate(a.start,b.start));
    if (segments[0].start !== cycleDraft.start || segments.at(-1).end !== cycleDraft.end) return "分段必须完整覆盖大周期";
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].name.trim() || compareDate(segments[i].start, segments[i].end) > 0) return "请完整填写分段名称和日期";
      if (i && addDays(segments[i - 1].end, 1) !== segments[i].start) return "分段之间不能重叠或留空";
    }
  }
  for (const [, allocation] of selected) {
    if (cents(allocation.total) <= 0) return "渠道总预算必须大于0";
    const channelId = selected.find(([, value]) => value === allocation)?.[0];
    if (state.cycles.some(cycle => cycle.allocations.some(item => item.channelId === channelId) && !(compareDate(cycle.end, cycleDraft.start) < 0 || compareDate(cycle.start, cycleDraft.end) > 0))) return "所选渠道与已有预算周期重叠";
    if (allocation.segmented) {
      const sum = allocation.segmentValues.reduce((total, value) => total + cents(value), 0);
      if (sum !== cents(allocation.total)) return "分段预算之和必须等于渠道总预算";
    }
  }
  return "";
}

function addDays(date, count) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + count);
  return value.toISOString().slice(0,10);
}

function openChannelDetail(cycleId, channelId) {
  const cycle = cycleById(state, cycleId);
  const channel = channelById(state, channelId);
  const allocation = cycle?.allocations.find(item => item.channelId === channelId);
  if (!cycle || !channel || !allocation) return;
  const snapshot = channelSnapshot(state, cycle, allocation);
  const history = state.budgetChanges.filter(item => item.cycleId === cycleId && item.channelId === channelId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const adjustable = ["active", "upcoming"].includes(cycleStatus(cycle)) && !cycle.archived;
  openDialog(`<div class="dialog-card">
    <div class="dialog-head"><div><p class="dialog-kicker">${h(accountById(state, cycle.accountId)?.name)} · ${h(cycle.name)}</p><h2 id="dialog-title">${h(channel.name)}</h2></div><button class="dialog-close" data-action="close-dialog" type="button">×</button></div>
    <div class="detail-balance"><span>${snapshot.scope === "segment" ? `${h(snapshot.segment?.name)}剩余` : "大周期剩余"}</span><strong>${money(snapshot.remaining)}</strong><small>${snapshot.days}天 · 每天 ${money(snapshot.daily)}</small></div>
    ${adjustable ? `<form id="budget-form" data-cycle-id="${cycle.id}" data-channel-id="${channel.id}"><label class="field"><span>把当前剩余额度调整为</span><input name="target" inputmode="decimal" min="0" step="0.01" value="${Math.max(0, snapshot.remaining) / 100}" required></label><button class="primary-button full" type="submit">保存预算调整</button></form>` : ""}
    <div class="history-block"><h3>预算修改历史</h3>${history.length ? history.map(item => `<div><span>${new Date(item.createdAt).toLocaleString("zh-CN", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })}</span><strong>${item.delta >= 0 ? "+" : "-"}${money(Math.abs(item.delta))}</strong></div>`).join("") : `<p class="form-note">还没有修改记录。</p>`}</div>
  </div>`);
}

function openNotifications() {
  const pending = pendingSettlements(state);
  openDialog(`<div class="dialog-card wide-dialog"><div class="dialog-head"><div><p class="dialog-kicker">消息</p><h2 id="dialog-title">结转待确认</h2></div><button class="dialog-close" data-action="close-dialog" type="button">×</button></div>
    <div class="settlement-list">${pending.length ? pending.map((item, index) => renderSettlement(item, index)).join("") : emptyState("全部处理完成", "目前没有待确认的结转。")}</div></div>`);
}

function renderSettlement(item, index) {
  const channel = channelById(state, item.allocation.channelId);
  const next = item.scope === "cycle" ? nextCycleForChannel(state, item.cycle, item.allocation.channelId) : null;
  const title = item.scope === "segment" ? `${channel?.name} · ${item.segment.name}` : `${channel?.name} · ${item.cycle.name}`;
  const text = item.kind === "surplus" ? `结余 ${money(item.amount)}` : `超支 ${money(item.amount)}`;
  const positive = item.kind === "surplus";
  return `<article class="settlement-card"><div><span>${item.scope === "segment" ? "分段结算" : "大周期结算"}</span><h3>${h(title)}</h3><strong class="${positive ? "positive-text" : "danger-text"}">${text}</strong>${item.scope === "cycle" && !next ? `<small>尚无包含此渠道的下一周期</small>` : ""}</div>
    <div class="settlement-actions">${positive ? `<button class="primary-button compact" data-action="settle" data-index="${index}" data-decision="carry" ${item.scope === "cycle" && !next ? "disabled" : ""} type="button">结转</button><button class="secondary-button" data-action="settle" data-index="${index}" data-decision="save" type="button">作为节余</button>` : `<button class="primary-button compact" data-action="settle" data-index="${index}" data-decision="deduct" ${item.scope === "cycle" && !next ? "disabled" : ""} type="button">扣减下期</button><button class="secondary-button" data-action="settle" data-index="${index}" data-decision="keep" type="button">保留超支</button>`}</div></article>`;
}

async function handleSubmit(event) {
  const form = event.target;
  if (form.id === "record-form") {
    event.preventDefault();
    const data = new FormData(form);
    const [cycleId, channelId] = String(data.get("context")).split("|");
    const existing = state.transactions.find(item => item.id === data.get("id"));
    const record = { id: existing?.id || uid("tx"), cycleId, channelId, type: data.get("type"), amount: cents(data.get("amount")), date: data.get("date"), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (existing) Object.assign(existing, record); else state.transactions.push(record);
    invalidateSettlements(cycleId, channelId);
    closeDialog();
    await persist(existing ? "记录已更新" : record.type === "refund" ? "退款已记录" : "支出已记录");
  }
  if (form.id === "entity-form") {
    event.preventDefault();
    const data = new FormData(form);
    const kind = form.dataset.kind;
    const list = kind === "account" ? state.accounts : state.channels;
    const existing = list.find(item => item.id === data.get("id"));
    const name = String(data.get("name")).trim();
    const accountId = kind === "channel" ? (data.get("accountId") || existing?.accountId) : null;
    const duplicate = list.some(item => item.id !== existing?.id && !item.archived && item.name === name && (kind === "account" || item.accountId === accountId));
    if (duplicate) return showToast("已有同名的可用项目");
    if (existing) existing.name = name;
    else list.push({ id: uid(kind === "account" ? "acc" : "ch"), name, accountId, order: kind === "account" ? state.accounts.length : state.channels.filter(item => item.accountId === accountId).length, archived: false, createdAt: new Date().toISOString() });
    closeDialog();
    await persist(existing ? "名称已更新" : "已创建");
  }
  if (form.id === "cycle-form") {
    event.preventDefault();
    syncCycleDraftFromForm();
    const error = validateCycleDraft();
    if (error) { const box = dialogContent.querySelector("#cycle-error"); box.textContent = error; box.classList.remove("hidden"); return; }
    const segments = cycleDraft.segments.map((segment, index) => ({ ...segment, id: uid("seg"), order: index }));
    const allocations = Object.entries(cycleDraft.selected).filter(([, value]) => value.enabled).map(([channelId, value]) => ({
      channelId, totalBudget: cents(value.total), segmented: value.segmented,
      segmentBudgets: value.segmented ? Object.fromEntries(segments.map((segment, index) => [segment.id, cents(value.segmentValues[index])])) : {}
    }));
    state.cycles.push({ id: uid("cy"), accountId: cycleDraft.accountId, name: cycleDraft.name.trim(), start: cycleDraft.start, end: cycleDraft.end, order: state.cycles.filter(item => item.accountId === cycleDraft.accountId && cycleStatus(item) === "active").length, archived: false, createdAt: new Date().toISOString(), segments, allocations });
    closeDialog();
    await persist("预算周期已创建");
  }
  if (form.id === "budget-form") {
    event.preventDefault();
    const cycle = cycleById(state, form.dataset.cycleId);
    const allocation = cycle.allocations.find(item => item.channelId === form.dataset.channelId);
    const snapshot = channelSnapshot(state, cycle, allocation);
    const target = cents(new FormData(form).get("target"));
    const delta = target - snapshot.remaining;
    if (allocation.segmented && snapshot.segment) allocation.segmentBudgets[snapshot.segment.id] += delta;
    allocation.totalBudget += delta;
    state.budgetChanges.push({ id: uid("chg"), cycleId: cycle.id, channelId: allocation.channelId, segmentId: snapshot.segment?.id || null, delta, createdAt: new Date().toISOString() });
    invalidateSettlements(cycle.id, allocation.channelId);
    closeDialog();
    await persist(`预算已${delta >= 0 ? "增加" : "减少"}${money(Math.abs(delta))}`);
  }
}

async function handleClick(event) {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { currentView = viewButton.dataset.view; render(); return; }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-dialog") closeDialog();
  if (action === "add-record") openRecordDialog();
  if (action === "edit-record") openRecordDialog(state.transactions.find(item => item.id === button.dataset.id));
  if (action === "notifications") openNotifications();
  if (action === "add-account") openEntityDialog("account");
  if (action === "add-channel") openEntityDialog("channel");
  if (action === "edit-account") openEntityDialog("account", accountById(state, button.dataset.id));
  if (action === "edit-channel") openEntityDialog("channel", channelById(state, button.dataset.id));
  if (action === "add-cycle") openCycleDialog();
  if (action === "channel-detail") openChannelDetail(button.dataset.cycleId, button.dataset.channelId);
  if (action === "cycle-details") { currentView = "records"; closeDialog(); render(); }
  if (action === "delete-record") {
    const tx = state.transactions.find(item => item.id === button.dataset.id);
    if (!tx || !confirm("确定删除这条记录吗？")) return;
    state.transactions = state.transactions.filter(item => item.id !== tx.id);
    invalidateSettlements(tx.cycleId, tx.channelId);
    closeDialog(); await persist("记录已删除");
  }
  if (action === "move-account") await moveItem(state.accounts, button.dataset.id, Number(button.dataset.direction), item => !item.archived);
  if (action === "move-channel") {
    const channel = channelById(state, button.dataset.id);
    await moveItem(state.channels, channel.id, Number(button.dataset.direction), item => item.accountId === channel.accountId && !item.archived);
  }
  if (action === "move-cycle") {
    const cycle = cycleById(state, button.dataset.id);
    await moveItem(state.cycles, cycle.id, Number(button.dataset.direction), item => item.accountId === cycle.accountId && cycleStatus(item) === "active");
  }
  if (action === "toggle-account") {
    const account = accountById(state, button.dataset.id);
    if (!account.archived && button.dataset.linked === "true") return showToast("请先归档该账户下的周期");
    account.archived = !account.archived; await persist(account.archived ? "账户已归档" : "账户已恢复");
  }
  if (action === "toggle-channel") {
    const channel = channelById(state, button.dataset.id);
    if (!channel.archived && button.dataset.used === "true") return showToast("请先归档包含此渠道的周期");
    channel.archived = !channel.archived; await persist(channel.archived ? "渠道已归档" : "渠道已恢复");
  }
  if (action === "archive-cycle") await archiveCycle(button.dataset.cycleId);
  if (action === "restore-cycle") { cycleById(state, button.dataset.id).archived = false; await persist("周期已恢复到已结束区域"); }
  if (action === "add-segment") {
    syncCycleDraftFromForm();
    const index = cycleDraft.segments.length;
    cycleDraft.segments.push({ name: `第${index + 1}分段`, start: index ? addDays(cycleDraft.segments[index - 1].end, 1) : cycleDraft.start, end: cycleDraft.end });
    renderCycleDialog();
  }
  if (action === "remove-segment") { syncCycleDraftFromForm(); cycleDraft.segments.splice(Number(button.dataset.index), 1); renderCycleDialog(); }
  if (action === "settle") await settlePending(Number(button.dataset.index), button.dataset.decision);
  if (action === "export") exportBackup();
  if (action === "reset") {
    if (!confirm("确定清除当前数据并恢复示例吗？建议先导出备份。")) return;
    await resetState(); state = seedState(); await persist("已恢复示例数据");
  }
}

async function moveItem(list, id, direction, predicate) {
  const items = list.filter(predicate).sort((a,b) => a.order-b.order);
  const index = items.findIndex(item => item.id === id);
  const target = items[index + direction];
  if (!target) return;
  const current = items[index];
  [current.order, target.order] = [target.order, current.order];
  await persist("顺序已调整");
}

async function archiveCycle(cycleId) {
  const cycle = cycleById(state, cycleId);
  if (!cycle || cycleStatus(cycle) !== "ended") return showToast("进行中的周期不能归档");
  if (pendingSettlements(state).some(item => item.cycle.id === cycleId)) return showToast("请先处理本周期的结转待确认");
  cycle.archived = true;
  await persist("周期已归档");
}

async function settlePending(index, decision) {
  const pending = pendingSettlements(state);
  const item = pending[index];
  if (!item) return;
  const target = item.scope === "cycle" && ["carry", "deduct"].includes(decision) ? nextCycleForChannel(state, item.cycle, item.allocation.channelId) : null;
  if (item.scope === "cycle" && ["carry", "deduct"].includes(decision) && !target) return showToast("请先创建包含此渠道的下一周期");
  state.settlements = state.settlements.filter(s => !(s.scope === item.scope && s.cycleId === item.cycle.id && s.channelId === item.allocation.channelId && (item.scope === "cycle" || s.segmentId === item.segment.id)));
  state.settlements.push({ id: uid("set"), scope: item.scope, cycleId: item.cycle.id, channelId: item.allocation.channelId, segmentId: item.segment?.id || null, targetCycleId: target?.id || null, kind: item.kind, amount: item.amount, decision, basisBudget: item.budget, basisActual: item.actual, createdAt: new Date().toISOString() });
  await saveState(state);
  openNotifications();
  render();
  showToast("结转处理已保存");
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `额度看板备份-${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("备份已导出");
}

function registerWebTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = tool => {
    try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch { /* unsupported preview */ }
  };
  register({
    name: "get_budget_summary",
    title: "读取预算概览",
    description: "读取当前进行中账户的总预算、实际支出和剩余总额度。",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute(input = {}) {
      const accounts = sortedAccounts(state).filter(account => !account.archived && (!input.accountId || account.id === input.accountId));
      return accounts.map(account => {
        const cycles = state.cycles.filter(cycle => cycle.accountId === account.id && cycleStatus(cycle) === "active");
        const totalBudget = cycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + allocation.totalBudget + incomingCycleAdjustment(state, cycle, allocation.channelId), 0), 0);
        const actualSpent = cycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + netTransactions(state, cycle.id, allocation.channelId), 0), 0);
        const remaining = cycles.reduce((sum, cycle) => sum + cycle.allocations.reduce((inner, allocation) => inner + spendableRemaining(state, cycle, allocation), 0), 0);
        return { accountId: account.id, accountName: account.name, totalBudgetCents: totalBudget, actualSpentCents: actualSpent, remainingCents: remaining };
      });
    }
  });
  register({
    name: "add_budget_record",
    title: "新增支出或退款",
    description: "向某个已有预算的开销渠道新增一笔支出或退款，日期必须落在该渠道的有效周期内。",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        type: { type: "string", enum: ["expense", "refund"] },
        amount: { type: "number", exclusiveMinimum: 0 }
      },
      required: ["channelId", "date", "type", "amount"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || !["expense", "refund"].includes(input.type) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !(Number(input.amount) > 0)) throw new Error("记录参数无效");
      const contexts = eligibleContexts(state, input.date).filter(item => item.channel.id === input.channelId);
      if (contexts.length !== 1) throw new Error("该渠道在指定日期没有唯一有效预算");
      const { cycle, channel } = contexts[0];
      const record = { id: uid("tx"), cycleId: cycle.id, channelId: channel.id, type: input.type, amount: cents(input.amount), date: input.date, createdAt: new Date().toISOString() };
      state.transactions.push(record);
      invalidateSettlements(cycle.id, channel.id);
      await saveState(state);
      render();
      return { id: record.id, cycleId: cycle.id, channelId: channel.id, type: record.type, amountCents: record.amount, date: record.date };
    }
  });
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.channels) || !Array.isArray(parsed.cycles) || !Array.isArray(parsed.transactions)) throw new Error();
    state = { settlements: [], budgetChanges: [], ...parsed };
    await persist("备份已恢复");
  } catch { showToast("备份文件无效"); }
}

function handleCycleDraftInput(event) {
  if (!dialogContent.querySelector("#cycle-form")) return;
  const input = event.target;
  if (input.name === "accountId") { syncCycleDraftFromForm(); cycleDraft.accountId = input.value; cycleDraft.selected = {}; renderCycleDialog(); return; }
  syncCycleDraftFromForm();
  if (input.dataset.key === "enabled" || input.dataset.key === "segmented") { renderCycleDialog(); return; }
  if (input.dataset.key === "total" || input.dataset.segmentBudget !== undefined) {
    const id = input.dataset.channelId;
    const allocation = cycleDraft.selected[id];
    if (allocation?.segmented && cycleDraft.segments.length > 1) {
      const index = Number(input.dataset.segmentBudget);
      if (input.dataset.key === "total" || index < cycleDraft.segments.length - 1) {
        const used = allocation.segmentValues.slice(0, -1).reduce((sum, value) => sum + (Number(value) || 0), 0);
        allocation.segmentValues[cycleDraft.segments.length - 1] = String(Math.max(0, (Number(allocation.total) || 0) - used));
        renderCycleDialog();
      }
    }
  }
}

app.addEventListener("click", handleClick);
app.addEventListener("submit", handleSubmit);
dialogContent.addEventListener("click", handleClick);
dialogContent.addEventListener("submit", handleSubmit);
dialogContent.addEventListener("change", handleCycleDraftInput);
dialogContent.addEventListener("input", event => {
  if (event.target.matches("[data-segment-index]")) syncCycleDraftFromForm();
});
dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(); });
document.addEventListener("change", event => { if (event.target.id === "import-file" && event.target.files[0]) importBackup(event.target.files[0]); });

async function init() {
  state = await loadState() || seedState();
  state.settlements ||= [];
  state.budgetChanges ||= [];
  await saveState(state);
  render();
  registerWebTools();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init().catch(() => {
  app.innerHTML = `<main class="app-shell">${header("额度看板")}<div class="empty-state"><strong>本地数据暂时无法打开</strong><span>请刷新页面后重试。</span></div></main>`;
});
