const desktop = window.codexDesktop;
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const state = { snapshot: null, config: null, settingsDraft: null, update: null, period: "30", device: "all", query: "", initialized: false, expandedSessionGroups: new Set() };
const colors = ["#1f9d68", "#5b8def", "#ff9e57", "#9b72cf", "#c7e65b", "#36b6c8", "#e86f8e"];
const usageKeys = ["input", "cached", "output", "reasoning", "total"];
const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

const number = (value) => fmt.format(value || 0);
const short = (value) => compact.format(value || 0);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const localDate = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const dateKey = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const offsetDateKey = (offset = 0) => { const value = new Date(); value.setHours(12, 0, 0, 0); value.setDate(value.getDate() + offset); return dateKey(value); };

function updateActionLabel(status) {
  if (!status) return "检查更新";
  if (status.phase === "checking") return "检查中…";
  if (status.phase === "available") return status.canAutoInstall ? "发现新版本" : "新版可下载";
  if (status.phase === "downloading") return `下载 ${Math.round(status.percent || 0)}%`;
  if (status.phase === "downloaded") return "重启安装";
  if (status.phase === "up-to-date") return "已是最新版";
  if (status.phase === "error") return "更新状态";
  return "检查更新";
}

function renderUpdateStatus(status = state.update) {
  if (!status) return;
  state.update = status;
  const topButton = document.querySelector("#updateButton");
  document.querySelector("#updateButtonText").textContent = updateActionLabel(status);
  topButton.dataset.phase = status.phase;
  topButton.disabled = status.phase === "checking";
  const version = document.querySelector("#updateVersionText");
  const message = document.querySelector("#updateStatusText");
  if (!version || !message) return;
  version.textContent = `当前 ${status.currentVersion}${status.availableVersion ? ` · 最新 ${status.availableVersion}` : ""}`;
  message.textContent = status.message || "尚未检查更新";
  const progress = document.querySelector("#updateProgress");
  progress.classList.toggle("hidden", status.phase !== "downloading" && status.phase !== "downloaded");
  document.querySelector("#updateProgressBar").style.width = `${status.phase === "downloaded" ? 100 : status.percent || 0}%`;
  const check = document.querySelector("#checkUpdateButton");
  check.disabled = status.phase === "checking" || status.phase === "downloading";
  check.textContent = status.phase === "checking" ? "检查中…" : "检查更新";
  document.querySelector("#downloadUpdateButton").classList.toggle("hidden", status.phase !== "available" || !status.canAutoInstall);
  document.querySelector("#installUpdateButton").classList.toggle("hidden", status.phase !== "downloaded" || !status.canAutoInstall);
  document.querySelector("#updateNote").textContent = status.portable
    ? "当前为免安装备用版；发现新版时会打开主安装版下载页。"
    : status.canAutoInstall
      ? "启动后和每 6 小时自动检查；下载及重启安装均由你确认。"
      : "当前运行方式不支持程序内安装，可从 GitHub Release 下载新版。";
}

async function checkForUpdates() {
  renderUpdateStatus(await desktop.checkForUpdates());
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.round(value / 60)} 分钟`;
  return `${(value / 3600).toFixed(value < 36000 ? 1 : 0)} 小时`;
}

function emptyBucket(date = "") {
  return { date, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, turns: 0, tools: 0, sessions: 0, activeSeconds: 0, models: {}, projects: {}, devices: {}, hours: {}, toolNames: {} };
}

function addMap(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => { target[key] = (target[key] || 0) + Number(value || 0); });
}

function addBucket(target, source) {
  usageKeys.forEach((key) => { target[key] += Number(source[key] || 0); });
  ["turns", "tools", "sessions", "activeSeconds"].forEach((key) => { target[key] += Number(source[key] || 0); });
  ["models", "projects", "devices", "hours", "toolNames"].forEach((key) => addMap(target[key], source[key]));
  return target;
}

function devices() {
  if (!state.snapshot?.local) return [];
  const expand = (data, peer = null) => {
    const hostName = peer?.name || data.device?.name || "未知设备";
    if (Array.isArray(data.sources) && data.sources.length) {
      return data.sources.map((source) => ({
        id: `${data.device?.id || peer?.id}:${source.id}`,
        name: `${hostName} · ${source.name}`,
        hostName,
        sourceName: source.name,
        online: true,
        local: !peer,
        latencyMs: peer?.latencyMs || 0,
        available: source.available !== false,
        data: source.data,
      }));
    }
    return [{ id: data.device?.id || peer?.id, name: hostName, hostName, sourceName: "默认数据源", online: true, local: !peer, latencyMs: peer?.latencyMs || 0, available: true, data }];
  };
  const local = expand(state.snapshot.local);
  const peers = state.snapshot.peers.filter((peer) => peer.online && peer.data).flatMap((peer) => expand(peer.data, peer));
  return [...local, ...peers];
}

function selectedData() {
  if (state.device === "all") return state.snapshot.aggregate || state.snapshot.local;
  return devices().find((device) => device.id === state.device)?.data || state.snapshot.aggregate || state.snapshot.local;
}

function mergeDaily() {
  return (selectedData()?.daily || []).map((row) => ({ ...emptyBucket(row.date), ...row }));
}

function periodBounds(period = state.period) {
  if (period === "all") return null;
  if (period === "today") return [offsetDateKey(0), offsetDateKey(0)];
  if (period === "yesterday") return [offsetDateKey(-1), offsetDateKey(-1)];
  const days = Math.max(1, Number(period) || 30);
  return [offsetDateKey(-(days - 1)), offsetDateKey(0)];
}

function periodLabel(period = state.period) {
  if (period === "today") return "今天";
  if (period === "yesterday") return "昨天";
  if (period === "all") return "全部时间";
  return `近 ${period} 天`;
}

function rangeRows(rows, period = state.period) {
  const bounds = periodBounds(period);
  if (!bounds) return rows;
  return rows.filter((row) => row.date >= bounds[0] && row.date <= bounds[1]);
}

function selectedRows() {
  return rangeRows(mergeDaily());
}

function sumRows(rows) {
  return rows.reduce((sum, row) => addBucket(sum, row), emptyBucket());
}

function previousPeriodRows(allRows) {
  if (state.period === "all") return [];
  if (state.period === "today") return rangeRows(allRows, "yesterday");
  if (state.period === "yesterday") return allRows.filter((row) => row.date === offsetDateKey(-2));
  const days = Math.max(1, Number(state.period) || 30);
  const end = new Date(); end.setHours(12, 0, 0, 0); end.setDate(end.getDate() - days);
  const start = new Date(end); start.setDate(start.getDate() - days + 1);
  const startKey = dateKey(start), endKey = dateKey(end);
  return allRows.filter((row) => row.date >= startKey && row.date <= endKey);
}

function agentTaskName(agentPath) {
  return String(agentPath || "").split("/").filter(Boolean).at(-1) || "";
}

function sessionAgentInfo(row) {
  const spawn = row?.source && typeof row.source === "object" ? row.source?.subagent?.thread_spawn : null;
  const agentPath = String(row?.agentPath || spawn?.agent_path || "");
  const isSubagent = row?.threadSource === "subagent" || Boolean(spawn);
  return {
    isSubagent,
    parentThreadId: String(row?.parentThreadId || spawn?.parent_thread_id || ""),
    rootSessionId: String(row?.rootSessionId || ""),
    nickname: String(row?.agentNickname || spawn?.agent_nickname || ""),
    path: agentPath,
    taskName: String(row?.agentTaskName || agentTaskName(agentPath)),
    depth: Number(row?.agentDepth ?? spawn?.depth ?? (isSubagent ? 1 : 0)),
  };
}

function sessionDisplayTitle(row) {
  const agent = sessionAgentInfo(row);
  if (agent.isSubagent) return ["子代理", agent.nickname, agent.taskName].filter(Boolean).join(" · ");
  return row?.title || "未命名会话";
}

function rootSessionId(row, sessionMap) {
  const agent = sessionAgentInfo(row);
  if (!agent.isSubagent) return row.id;
  if (agent.rootSessionId && agent.rootSessionId !== row.id) return agent.rootSessionId;
  let currentId = agent.parentThreadId;
  const visited = new Set([row.id]);
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = sessionMap.get(currentId);
    if (!current) return currentId;
    const currentAgent = sessionAgentInfo(current);
    if (!currentAgent.isSubagent) return current.id;
    if (currentAgent.rootSessionId && currentAgent.rootSessionId !== current.id) return currentAgent.rootSessionId;
    currentId = currentAgent.parentThreadId;
  }
  return agent.parentThreadId || row.id;
}

function selectedSessions() {
  const complete = [...(selectedData()?.sessions || [])];
  const sessionMap = new Map(complete.map((row) => [row.id, row]));
  let rows = [...complete];
  const bounds = periodBounds();
  if (bounds) rows = rows.filter((row) => row.date && row.date >= bounds[0] && row.date <= bounds[1]);
  if (state.query) {
    const query = state.query.toLowerCase();
    rows = rows.filter((row) => {
      const agent = sessionAgentInfo(row);
      const root = sessionMap.get(rootSessionId(row, sessionMap));
      return [row.deviceName, row.sourceName, sessionDisplayTitle(row), row.title, row.model, row.project, row.cwd, row.id, agent.nickname, agent.taskName, agent.path, root?.title]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  }
  return rows.sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
}

function renderDevicePicker() {
  const picker = document.querySelector("#devicePicker");
  const previous = state.device;
  picker.innerHTML = `<option value="all">全部来源（${devices().length}）</option>` + devices().map((device) => `<option value="${escapeHtml(device.id)}">${device.local ? "本机 · " : "远程 · "}${escapeHtml(device.name)}</option>`).join("");
  if ([...picker.options].some((option) => option.value === previous)) picker.value = previous;
  else state.device = "all";
}

function renderConnectionBanner() {
  const peers = state.snapshot.peers || [];
  const online = peers.filter((peer) => peer.online).length;
  const banner = document.querySelector("#connectionBanner");
  if (!state.config.peers.length) {
    banner.className = "connection-banner setup";
    banner.innerHTML = `<div><strong>已汇总 ${devices().length} 个本地数据源</strong><span>Windows 与 WSL 目录会先按会话 ID 全局去重；其他电脑可继续通过 Tailscale 接入。</span></div><button data-open-settings>管理来源</button>`;
  } else if (online < peers.length) {
    const failed = peers.filter((peer) => !peer.online).map((peer) => `${peer.name}：${peer.error}`).join("；");
    banner.className = "connection-banner warning";
    banner.innerHTML = `<div><strong>${online}/${peers.length} 台远程设备在线</strong><span>${escapeHtml(failed)}</span></div><button data-open-settings>检查设置</button>`;
  } else {
    banner.className = "connection-banner connected";
    banner.innerHTML = `<div><strong>${devices().length} 个数据源已去重汇总</strong><span>Tailscale 加密链路正常，远程统计延迟 ${peers.map((peer) => `${peer.name} ${peer.latencyMs}ms`).join(" · ") || "—"}</span></div><i></i>`;
  }
}

function renderCards(rows) {
  const sum = sumRows(rows);
  const sessions = selectedSessions();
  const subagentCount = sessions.filter((row) => sessionAgentInfo(row).isSubagent).length;
  const primaryCount = Math.max(0, sessions.length - subagentCount);
  const nonCached = Math.max(0, sum.input - sum.cached);
  const cacheRate = sum.input ? sum.cached / sum.input * 100 : 0;
  const all = mergeDaily();
  const previous = sumRows(previousPeriodRows(all));
  const growth = previous.total ? (sum.total - previous.total) / previous.total * 100 : null;
  const compareLabel = state.period === "today" ? "较昨日" : state.period === "yesterday" ? "较前日" : "较前期";
  const cards = [
    ["总 Token 流量", short(sum.total), growth === null ? `${number(sum.total)} tokens` : `${compareLabel} ${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%`, "primary"],
    ["非缓存输入", short(nonCached), `占总流量 ${sum.total ? (nonCached / sum.total * 100).toFixed(1) : 0}%`, ""],
    ["缓存输入", short(sum.cached), `缓存命中 ${cacheRate.toFixed(1)}%`, "mint"],
    ["模型输出", short(sum.output), `推理 ${short(sum.reasoning)}`, "orange"],
    ["会话", number(sum.sessions), `${number(primaryCount)} 个主会话 · ${number(subagentCount)} 个子代理`, ""],
    ["工具调用", number(sum.tools), `${Object.keys(sum.toolNames).length} 种工具`, ""],
    ["任务耗时", duration(sum.activeSeconds), `日均 ${duration(sum.activeSeconds / Math.max(1, rows.filter((row) => row.total).length))}`, ""],
    ["数据源", number(devices().length), `${state.snapshot.peers.filter((peer) => peer.online).length} 台远程在线`, ""],
  ];
  document.querySelector("#metricCards").innerHTML = cards.map(([label, value, foot, type]) => `<article class="metric ${type}"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></article>`).join("");
}

function bucketForDate(date, rows = mergeDaily()) {
  return rows.find((row) => row.date === date) || emptyBucket(date);
}

function comparison(current, previous) {
  if (!previous && !current) return { text: "—", className: "neutral" };
  if (!previous && current) return { text: "新增", className: "up" };
  const rate = (current - previous) / previous * 100;
  if (Math.abs(rate) < 0.05) return { text: "持平", className: "neutral" };
  return { text: `${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`, className: rate > 0 ? "up" : "down" };
}

function renderTodayYesterday() {
  const rows = mergeDaily();
  const today = bucketForDate(offsetDateKey(0), rows);
  const yesterday = bucketForDate(offsetDateKey(-1), rows);
  const totalChange = comparison(today.total, yesterday.total);
  document.querySelector("#dayCompareNote").textContent = `${today.date} / ${yesterday.date}`;
  document.querySelector("#dayHeadlines").innerHTML = `
    <div class="day-headline today"><span>今天总流量</span><strong>${short(today.total)}</strong><small>${number(today.total)} tokens</small></div>
    <div class="day-headline yesterday"><span>昨天总流量</span><strong>${short(yesterday.total)}</strong><small>${number(yesterday.total)} tokens</small></div>
    <div class="day-headline delta"><span>今日较昨日</span><strong class="${totalChange.className}">${totalChange.text}</strong><small>${today.total || yesterday.total ? `${today.total >= yesterday.total ? "增加" : "减少"} ${short(Math.abs(today.total - yesterday.total))}` : "两天均无用量"}</small></div>`;

  const metrics = [
    ["总 Token", (row) => row.total, short],
    ["非缓存输入", (row) => Math.max(0, row.input - row.cached), short],
    ["缓存输入", (row) => row.cached, short],
    ["模型输出", (row) => row.output, short],
    ["推理输出", (row) => row.reasoning, short],
    ["会话数", (row) => row.sessions, number],
    ["对话轮次", (row) => row.turns, number],
    ["工具调用", (row) => row.tools, number],
    ["任务耗时", (row) => row.activeSeconds, duration],
    ["活跃来源", (row) => Object.values(row.devices).filter(Boolean).length, number],
  ];
  document.querySelector("#dayCompareTable").innerHTML = `<div class="day-compare-row header"><span>指标</span><b>今天</b><b>昨天</b><b>变化</b></div>` + metrics.map(([label, getter, formatter]) => {
    const current = getter(today), previous = getter(yesterday), delta = comparison(current, previous);
    return `<div class="day-compare-row"><span>${label}</span><b>${formatter(current)}</b><b>${formatter(previous)}</b><b class="${delta.className}">${delta.text}</b></div>`;
  }).join("");

  const todayHours = Array(24).fill(0), yesterdayHours = Array(24).fill(0);
  Object.entries(today.hours || {}).forEach(([hour, value]) => { todayHours[Number(hour)] = value; });
  Object.entries(yesterday.hours || {}).forEach(([hour, value]) => { yesterdayHours[Number(hour)] = value; });
  const maximum = Math.max(1, ...todayHours, ...yesterdayHours);
  document.querySelector("#dayHourChart").innerHTML = todayHours.map((value, hour) => `<div class="day-hour-column" title="${String(hour).padStart(2, "0")}:00 · 今天 ${number(value)} · 昨天 ${number(yesterdayHours[hour])}"><div><i class="today" style="height:${Math.max(value ? 3 : 1, value / maximum * 100)}%"></i><i class="yesterday" style="height:${Math.max(yesterdayHours[hour] ? 3 : 1, yesterdayHours[hour] / maximum * 100)}%"></i></div><span>${hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span></div>`).join("");
}

function renderDailyDetails() {
  const rows = mergeDaily();
  const rowMap = Object.fromEntries(rows.map((row) => [row.date, row]));
  const dailyRows = [];
  for (let offset = 0; offset > -14; offset -= 1) {
    const key = offsetDateKey(offset);
    const row = rowMap[key] || emptyBucket(key);
    const previous = rowMap[offsetDateKey(offset - 1)] || emptyBucket(offsetDateKey(offset - 1));
    dailyRows.push({ row, previous, offset });
  }
  document.querySelector("#dailyDetailRows").innerHTML = dailyRows.map(({ row, previous, offset }) => {
    const delta = comparison(row.total, previous.total);
    const label = offset === 0 ? "今天" : offset === -1 ? "昨天" : new Date(`${row.date}T12:00:00`).toLocaleDateString("zh-CN", { weekday: "short" });
    return `<tr class="${offset === 0 ? "today-row" : offset === -1 ? "yesterday-row" : ""}"><td><strong>${row.date.slice(5)}</strong><small>${label}</small></td><td><strong>${short(row.total)}</strong></td><td><span class="change-pill ${delta.className}">${delta.text}</span></td><td>${short(Math.max(0, row.input - row.cached))}</td><td>${short(row.cached)}</td><td>${short(row.output)}</td><td>${short(row.reasoning)}</td><td>${number(row.sessions)}</td><td>${number(row.turns)}</td><td>${number(row.tools)}</td><td>${duration(row.activeSeconds)}</td><td>${Object.values(row.devices).filter(Boolean).length}</td></tr>`;
  }).join("");
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * ratio); canvas.height = Math.max(1, rect.height * ratio);
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio);
  return { ctx, width: rect.width, height: rect.height };
}

function renderTrend(rows) {
  const canvas = document.querySelector("#trendChart");
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 52, r: 14, t: 12, b: 28 }, chartWidth = width - pad.l - pad.r, chartHeight = height - pad.t - pad.b;
  const values = rows.map((row) => ({ input: Math.max(0, row.input - row.cached), cached: row.cached, output: row.output }));
  const maximum = Math.max(1, ...values.map((value) => value.input + value.cached + value.output));
  ctx.clearRect(0, 0, width, height); ctx.font = "10px system-ui"; ctx.fillStyle = "#829087"; ctx.strokeStyle = "#e5eae4";
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.t + chartHeight * index / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
    ctx.fillText(short(maximum * (4 - index) / 4), 4, y + 3);
  }
  if (!rows.length) return;
  const step = chartWidth / rows.length, bar = Math.max(3, Math.min(19, step * 0.64));
  rows.forEach((_row, index) => {
    const x = pad.l + step * index + (step - bar) / 2; let y = pad.t + chartHeight;
    [["input", "#1f9d68"], ["cached", "#8ad9b2"], ["output", "#ff9e57"]].forEach(([key, color]) => {
      const barHeight = values[index][key] / maximum * chartHeight;
      y -= barHeight; ctx.fillStyle = color; ctx.fillRect(x, y, bar, barHeight);
    });
  });
  const labels = Math.min(6, rows.length); ctx.fillStyle = "#829087"; ctx.textAlign = "center";
  for (let index = 0; index < labels; index += 1) {
    const rowIndex = Math.round(index * (rows.length - 1) / Math.max(1, labels - 1));
    ctx.fillText(rows[rowIndex].date.slice(5), pad.l + step * rowIndex + step / 2, height - 8);
  }
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left - pad.l) / step);
    const tooltip = document.querySelector("#chartTooltip");
    if (index < 0 || index >= rows.length) return tooltip.classList.add("hidden");
    const row = rows[index], value = values[index];
    tooltip.innerHTML = `<strong>${row.date}</strong><br>总流量 ${number(row.total)}<br>非缓存输入 ${number(value.input)}<br>缓存输入 ${number(value.cached)}<br>输出 ${number(value.output)}<br>来源 ${Object.keys(row.devices).length} 个`;
    tooltip.style.left = `${Math.min(width - 184, Math.max(0, event.clientX - rect.left + 12))}px`;
    tooltip.style.top = `${Math.max(4, event.clientY - rect.top - 86)}px`;
    tooltip.classList.remove("hidden");
  };
  canvas.onmouseleave = () => document.querySelector("#chartTooltip").classList.add("hidden");
}

function sortedMap(map) {
  return Object.entries(map || {}).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
}

function renderModels(rows) {
  const map = {}; rows.forEach((row) => addMap(map, row.models));
  const entries = sortedMap(map), total = entries.reduce((sum, item) => sum + item[1], 0);
  const canvas = document.querySelector("#modelChart"), { ctx, width, height } = setupCanvas(canvas), centerX = width / 2, centerY = height / 2, radius = Math.min(width, height) * 0.42;
  let angle = -Math.PI / 2;
  entries.forEach((item, index) => {
    const next = angle + item[1] / Math.max(1, total) * Math.PI * 2;
    ctx.beginPath(); ctx.arc(centerX, centerY, radius, angle, next); ctx.arc(centerX, centerY, radius * 0.6, next, angle, true); ctx.closePath();
    ctx.fillStyle = colors[index % colors.length]; ctx.fill(); angle = next;
  });
  if (!entries.length) { ctx.beginPath(); ctx.arc(centerX, centerY, radius, 0, Math.PI * 2); ctx.fillStyle = "#e6ebe5"; ctx.fill(); }
  ctx.fillStyle = "#18211c"; ctx.textAlign = "center"; ctx.font = "800 21px system-ui"; ctx.fillText(short(total), centerX, centerY + 3);
  ctx.fillStyle = "#748078"; ctx.font = "10px system-ui"; ctx.fillText("TOKENS", centerX, centerY + 20);
  document.querySelector("#modelLegend").innerHTML = entries.slice(0, 6).map((item, index) => `<div class="model-item"><i style="background:${colors[index % colors.length]}"></i><span title="${escapeHtml(item[0])}">${escapeHtml(item[0])}</span><strong>${total ? (item[1] / total * 100).toFixed(1) : 0}%</strong></div>`).join("") || '<div class="empty">暂无模型数据</div>';
}

function renderPeaks(rows) {
  const peakDay = rows.reduce((best, row) => !best || row.total > best.total ? row : best, null);
  const sessions = selectedSessions();
  const peakSession = sessions.reduce((best, row) => !best || row.total > best.total ? row : best, null);
  const sum = sumRows(rows);
  const peakHour = sortedMap(sum.hours)[0];
  const peakProject = sortedMap(sum.projects)[0];
  const simultaneous = rows.filter((row) => Object.values(row.devices).filter(Boolean).length > 1).length;
  const peakDevice = devices().map((device) => {
    const deviceRows = rangeRows(device.data.daily);
    return { name: device.name, peak: deviceRows.reduce((best, row) => !best || row.total > best.total ? row : best, null) };
  }).sort((a, b) => (b.peak?.total || 0) - (a.peak?.total || 0))[0];
  const items = [
    ["汇总单日峰值", peakDay?.date || "—", peakDay ? `${short(peakDay.total)} tokens` : "暂无数据"],
    ["来源单日峰值", peakDevice?.name || "—", peakDevice?.peak ? `${peakDevice.peak.date} · ${short(peakDevice.peak.total)}` : "暂无数据"],
    ["最大会话", peakSession ? sessionDisplayTitle(peakSession) : "—", peakSession ? `${peakSession.originName || peakSession.deviceName} · ${short(peakSession.total)}` : "暂无数据"],
    ["最高流量时段", peakHour ? `${String(peakHour[0]).padStart(2, "0")}:00` : "—", peakHour ? `${short(peakHour[1])} tokens` : "暂无数据"],
    ["最高流量项目", peakProject?.[0] || "—", peakProject ? `${short(peakProject[1])} tokens` : "暂无数据"],
    ["多来源同时活跃", `${simultaneous} 天`, simultaneous ? "多个来源同日产生流量" : "所选范围内暂无重叠"],
  ];
  document.querySelector("#peakGrid").innerHTML = items.map(([label, value, note]) => `<div class="peak-item"><span>${label}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
}

function renderRanking(selector, entries, formatter = short, limit = 7) {
  const rows = entries.slice(0, limit), maximum = rows[0]?.[1] || 1;
  document.querySelector(selector).innerHTML = rows.map(([name, value], index) => `<div class="rank-row"><span class="rank-index">${index + 1}</span><div class="rank-main"><div><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><span>${formatter(value)}</span></div><i><b style="width:${Math.max(2, value / maximum * 100)}%"></b></i></div></div>`).join("") || '<div class="empty">暂无数据</div>';
}

function renderDeviceComparison() {
  const entries = devices().map((device) => {
    const rows = rangeRows(device.data.daily);
    const sum = sumRows(rows);
    const peak = rows.reduce((best, row) => !best || row.total > best.total ? row : best, null);
    return [device.name, sum.total, peak];
  }).sort((a, b) => b[1] - a[1]);
  const maximum = entries[0]?.[1] || 1;
  document.querySelector("#deviceComparison").innerHTML = entries.map(([name, value, peak], index) => `<div class="device-row"><div class="device-line"><span class="device-color" style="background:${colors[index % colors.length]}"></span><strong>${escapeHtml(name)}</strong><b>${short(value)}</b></div><div class="device-bar"><i style="width:${Math.max(2, value / maximum * 100)}%;background:${colors[index % colors.length]}"></i></div><small>来源峰值：${peak ? `${peak.date} · ${short(peak.total)}` : "暂无"}</small></div>`).join("");
}

function renderHourChart(rows) {
  const hours = Array(24).fill(0); rows.forEach((row) => Object.entries(row.hours || {}).forEach(([hour, value]) => { hours[Number(hour)] += value; }));
  const maximum = Math.max(1, ...hours);
  document.querySelector("#hourChart").innerHTML = hours.map((value, hour) => `<div class="hour-column" title="${String(hour).padStart(2, "0")}:00 · ${number(value)} tokens"><i style="height:${Math.max(value ? 5 : 1, value / maximum * 100)}%"></i><span>${hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span></div>`).join("");
}

function renderActivity(rows) {
  const source = mergeDaily();
  if (!source.length) return;
  const map = Object.fromEntries(source.map((row) => [row.date, row.total]));
  const end = new Date(`${source.at(-1).date}T00:00:00`), start = new Date(end); start.setDate(start.getDate() - 139);
  const values = Object.values(map).filter(Boolean).sort((a, b) => a - b), percentile = values[Math.floor(values.length * 0.75)] || 1;
  const cells = [];
  for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const date = dateKey(day), value = map[date] || 0;
    const level = value ? Math.min(4, Math.max(1, Math.ceil(value / percentile * 3))) : 0;
    cells.push(`<i data-level="${level}" title="${date}：${number(value)} tokens"></i>`);
  }
  document.querySelector("#activityGrid").innerHTML = cells.join("");
  document.querySelector("#activityNote").textContent = `${rows.filter((row) => row.total).length} 个活跃日`;
}

function renderInsights(rows) {
  const sum = sumRows(rows), activeDays = rows.filter((row) => row.total > 0), sessions = selectedSessions();
  const cacheRate = sum.input ? sum.cached / sum.input * 100 : 0;
  const outputRate = Math.max(1, sum.input - sum.cached) ? sum.output / Math.max(1, sum.input - sum.cached) : 0;
  const averageSession = sessions.length ? sessions.reduce((total, row) => total + row.total, 0) / sessions.length : 0;
  const bestDevice = devices().map((device) => [device.name, sumRows(rangeRows(device.data.daily)).total]).sort((a, b) => b[1] - a[1])[0];
  const items = [
    ["日均流量", short(activeDays.length ? sum.total / activeDays.length : 0), `${activeDays.length} 个活跃日`],
    ["平均会话流量", short(averageSession), `${sessions.length} 个会话`],
    ["缓存命中率", `${cacheRate.toFixed(1)}%`, cacheRate > 80 ? "上下文复用较高" : "缓存比例偏低"],
    ["输出 / 新输入", outputRate.toFixed(3), "每 1 个新输入 Token 的输出量"],
    ["推理输出占比", `${sum.output ? (sum.reasoning / sum.output * 100).toFixed(1) : 0}%`, `${short(sum.reasoning)} reasoning tokens`],
    ["主力来源", bestDevice?.[0] || "—", bestDevice ? `${short(bestDevice[1])} tokens` : "暂无数据"],
  ];
  document.querySelector("#insights").innerHTML = items.map(([label, value, note]) => `<div class="insight"><span>${label}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
}

function renderSessions() {
  const all = selectedSessions(), rows = all.slice(0, 300);
  const complete = [...(selectedData()?.sessions || [])];
  const sessionMap = new Map(complete.map((row) => [row.id, row]));
  const groups = new Map();
  const entries = [];

  for (const row of rows) {
    const agent = sessionAgentInfo(row);
    if (!agent.isSubagent) {
      entries.push({ type: "session", row, endedAt: row.endedAt || "" });
      continue;
    }
    const rootId = rootSessionId(row, sessionMap);
    if (!groups.has(rootId)) {
      const group = { type: "group", rootId, root: sessionMap.get(rootId), children: [], endedAt: row.endedAt || "" };
      groups.set(rootId, group);
      entries.push(group);
    }
    const group = groups.get(rootId);
    group.children.push(row);
    if (String(row.endedAt || "") > group.endedAt) group.endedAt = row.endedAt || "";
  }

  // 根会话已经由父任务分组标题承载，不再重复显示为一条普通会话。
  const groupedRootIds = new Set(groups.keys());
  const ordered = entries.filter((entry) => entry.type !== "session" || !groupedRootIds.has(entry.row.id))
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  const sessionHtml = (row, child = false) => {
    const title = sessionDisplayTitle(row);
    const agent = sessionAgentInfo(row);
    const visibleTitle = child ? [agent.nickname, agent.taskName].filter(Boolean).join(" · ") || title : title;
    const agentTag = child ? '<span class="subagent-tag">子代理</span>' : "";
    return `<tr class="${child ? "subagent-row" : ""}"><td><div class="device-tag">${escapeHtml(row.originName || [row.deviceName, row.sourceName].filter(Boolean).join(" · "))}</div><div class="session-title-wrap">${agentTag}<div class="session-name" title="${escapeHtml(title)}">${escapeHtml(visibleTitle)}</div></div></td><td>${localDate(row.startedAt)}</td><td>${escapeHtml(row.project)}</td><td><span class="model-pill">${escapeHtml(row.model)}</span></td><td>${short(Math.max(0, row.input - row.cached))}</td><td>${short(row.cached)}</td><td>${short(row.output)}</td><td>${duration(row.activeSeconds)}</td><td><strong>${short(row.total)}</strong></td></tr>`;
  };
  const html = ordered.map((entry) => {
    if (entry.type === "session") return sessionHtml(entry.row);
    const root = entry.root;
    const members = root && rows.some((row) => row.id === root.id) ? [root, ...entry.children] : entry.children;
    const aggregate = members.reduce((sum, row) => {
      usageKeys.forEach((key) => { sum[key] += Number(row[key] || 0); });
      sum.activeSeconds += Number(row.activeSeconds || 0);
      return sum;
    }, { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, activeSeconds: 0 });
    const parentTitle = root?.title && root.title !== "未命名会话" ? root.title : `父任务 ${entry.rootId.slice(0, 8)}`;
    const project = root?.project || entry.children[0]?.project || "未知项目";
    const models = [...new Set(members.map((row) => row.model).filter(Boolean))];
    const expanded = Boolean(state.query) || state.expandedSessionGroups.has(entry.rootId);
    const header = `<tr class="session-group-row"><td><button class="session-group-toggle" data-session-group="${escapeHtml(entry.rootId)}" aria-expanded="${expanded}"><span class="group-chevron">${expanded ? "▾" : "▸"}</span><span><strong title="${escapeHtml(parentTitle)}">${escapeHtml(parentTitle)}</strong><small>${entry.children.length} 个子代理会话${root ? ` · 父会话 ${root.id.slice(0, 8)}` : ""}</small></span></button></td><td>${localDate(entry.endedAt)}</td><td>${escapeHtml(project)}</td><td><span class="model-pill">${escapeHtml(models.length === 1 ? models[0] : `${models.length} 个模型`)}</span></td><td>${short(Math.max(0, aggregate.input - aggregate.cached))}</td><td>${short(aggregate.cached)}</td><td>${short(aggregate.output)}</td><td>${duration(aggregate.activeSeconds)}</td><td><strong>${short(aggregate.total)}</strong></td></tr>`;
    return header + (expanded ? entry.children.sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || ""))).map((row) => sessionHtml(row, true)).join("") : "");
  }).join("");
  document.querySelector("#sessionRows").innerHTML = html || '<tr><td colspan="9" class="empty">没有匹配的会话</td></tr>';
  document.querySelector("#tableNote").textContent = `显示 ${rows.length} / ${all.length} 个会话 · ${groups.size} 个父任务分组 · 子代理默认折叠`;
}

function render() {
  renderDevicePicker();
  renderConnectionBanner();
  const rows = selectedRows(), sum = sumRows(rows);
  renderCards(rows); renderTodayYesterday(); renderTrend(rows); renderModels(rows); renderPeaks(rows); renderDeviceComparison();
  renderRanking("#projectRanking", sortedMap(sum.projects));
  renderHourChart(rows);
  renderRanking("#toolRanking", sortedMap(sum.toolNames), number);
  renderActivity(rows); renderInsights(rows); renderDailyDetails(); renderSessions();
  const aggregate = state.snapshot.aggregate || state.snapshot.local;
  const dedupeText = aggregate.dedupeMode === "partial" ? "部分来源为旧版，跨设备或子代理去重受限" : `已排除 ${number(aggregate.duplicateSessions)} 个重复副本/子代理累计镜像`;
  document.querySelector("#subtitle").textContent = `${periodLabel()} · ${devices().length} 个数据源 · ${state.snapshot.local.filesScanned} 个本地日志 · ${dedupeText}`;
}

function renderSourceEditor() {
  const sources = state.settingsDraft.sources || [];
  document.querySelector("#sourceEditor").innerHTML = sources.map((source, index) => `<div class="source-card" data-source-index="${index}"><label><span>来源名称</span><input data-field="name" value="${escapeHtml(source.name)}" placeholder="例如 WSL 或 Windows"></label><label class="wide"><span>.codex 目录</span><div class="input-action"><input data-field="path" value="${escapeHtml(source.path)}"><button type="button" data-choose-source="${index}">选择</button></div></label><label class="source-enabled"><input type="checkbox" data-field="enabled" ${source.enabled !== false ? "checked" : ""}>启用</label><button class="remove-source" data-remove-source="${index}">删除</button></div>`).join("") || '<div class="empty-box">至少添加一个包含 sessions 或 archived_sessions 的 .codex 目录。</div>';
}

function renderPeerEditor() {
  const peers = state.settingsDraft.peers || [];
  document.querySelector("#peerEditor").innerHTML = peers.map((peer, index) => `<div class="peer-card" data-peer-index="${index}"><label><span>设备名称</span><input data-field="name" value="${escapeHtml(peer.name)}" placeholder="例如 Windows 工作站"></label><label><span>Tailscale 地址</span><input data-field="address" value="${escapeHtml(peer.address)}" placeholder="100.x.x.x 或 MagicDNS 名称"></label><label class="wide"><span>对端访问令牌</span><input data-field="token" value="${escapeHtml(peer.token)}" placeholder="从另一台电脑复制"></label><label class="peer-enabled"><input type="checkbox" data-field="enabled" ${peer.enabled !== false ? "checked" : ""}>启用</label><button class="remove-peer" data-remove-peer="${index}">删除</button></div>`).join("") || '<div class="empty-box">还没有远程设备。请先在 Windows 打开本应用，复制它的地址和令牌。</div>';
}

function readSettingsForm() {
  if (!state.settingsDraft) return;
  state.settingsDraft.deviceName = document.querySelector("#deviceNameInput").value;
  state.settingsDraft.shareEnabled = document.querySelector("#shareEnabledInput").checked;
  state.settingsDraft.sharePort = Number(document.querySelector("#sharePortInput").value);
  document.querySelectorAll(".source-card").forEach((card) => {
    const source = state.settingsDraft.sources[Number(card.dataset.sourceIndex)];
    card.querySelectorAll("[data-field]").forEach((input) => { source[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value; });
  });
  document.querySelectorAll(".peer-card").forEach((card) => {
    const peer = state.settingsDraft.peers[Number(card.dataset.peerIndex)];
    card.querySelectorAll("[data-field]").forEach((input) => { peer[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value; });
  });
}

async function openSettings() {
  state.config = await desktop.getConfig();
  const system = await desktop.getSystemInfo();
  state.settingsDraft = structuredClone(state.config);
  document.querySelector("#deviceNameInput").value = state.settingsDraft.deviceName;
  document.querySelector("#shareEnabledInput").checked = state.settingsDraft.shareEnabled;
  document.querySelector("#sharePortInput").value = state.settingsDraft.sharePort;
  document.querySelector("#shareAddressText").textContent = system.shareAddress || (system.tailscaleIp ? `http://${system.tailscaleIp}:${state.settingsDraft.sharePort}` : "未检测到 Tailscale 地址");
  document.querySelector("#shareTokenText").textContent = state.settingsDraft.shareToken;
  document.querySelector("#settingsMessage").textContent = system.shareError || "";
  renderSourceEditor();
  renderPeerEditor();
  document.querySelector("#settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.querySelector("#settingsModal").classList.add("hidden");
}

async function load(refresh = false) {
  const button = document.querySelector("#refreshButton"); button.disabled = true;
  try {
    state.snapshot = refresh ? await desktop.refresh() : await desktop.getSnapshot();
    state.config = await desktop.getConfig();
    document.querySelector("#loading").classList.add("hidden");
    document.querySelector("#dashboard").classList.remove("hidden");
    render();
    if (!state.initialized) {
      // Chromium 会记住上次关闭时的滚动位置；仅首次启动回到总览，自动刷新时不能打断用户阅读。
      requestAnimationFrame(() => window.scrollTo(0, 0));
      setTimeout(() => window.scrollTo(0, 0), 200);
      state.initialized = true;
    }
  } catch (error) {
    document.querySelector("#loading").innerHTML = `<div><strong>读取失败</strong><span>${escapeHtml(error.message)}</span></div>`;
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#rangePicker").onclick = (event) => {
  const button = event.target.closest("button"); if (!button) return;
  document.querySelectorAll("#rangePicker button").forEach((item) => item.classList.remove("active")); button.classList.add("active");
  state.period = button.dataset.period; render();
};
document.querySelector("#devicePicker").onchange = (event) => { state.device = event.target.value; render(); };
document.querySelector("#refreshButton").onclick = () => load(true);
document.querySelector("#updateButton").onclick = () => {
  if (state.update?.phase === "downloaded" && state.update.canAutoInstall) desktop.installUpdate();
  else if (state.update?.phase === "available" && state.update.canAutoInstall) desktop.downloadUpdate();
  else checkForUpdates();
};
document.querySelector("#settingsButton").onclick = openSettings;
document.querySelector("#checkUpdateButton").onclick = checkForUpdates;
document.querySelector("#downloadUpdateButton").onclick = async () => renderUpdateStatus(await desktop.downloadUpdate());
document.querySelector("#installUpdateButton").onclick = () => desktop.installUpdate();
document.querySelector("#openReleaseButton").onclick = () => desktop.openReleasePage();
document.querySelector("#sessionSearch").oninput = (event) => { state.query = event.target.value.trim(); renderSessions(); };
document.querySelector("#sessionRows").onclick = (event) => {
  const button = event.target.closest("[data-session-group]");
  if (!button || state.query) return;
  const groupId = button.dataset.sessionGroup;
  if (state.expandedSessionGroups.has(groupId)) state.expandedSessionGroups.delete(groupId);
  else state.expandedSessionGroups.add(groupId);
  renderSessions();
};
document.body.onclick = (event) => {
  if (event.target.closest("[data-open-settings]")) openSettings();
  if (event.target.closest("[data-close-settings]")) closeSettings();
  const remove = event.target.closest("[data-remove-peer]");
  if (remove) { readSettingsForm(); state.settingsDraft.peers.splice(Number(remove.dataset.removePeer), 1); renderPeerEditor(); }
  const removeSource = event.target.closest("[data-remove-source]");
  if (removeSource) { readSettingsForm(); state.settingsDraft.sources.splice(Number(removeSource.dataset.removeSource), 1); renderSourceEditor(); }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    const value = copy.dataset.copy === "token" ? state.settingsDraft.shareToken : document.querySelector("#shareAddressText").textContent;
    navigator.clipboard.writeText(value); copy.textContent = "已复制"; setTimeout(() => { copy.textContent = copy.dataset.copy === "token" ? "复制令牌" : "复制地址"; }, 1200);
  }
};
document.querySelector("#addPeerButton").onclick = () => { readSettingsForm(); state.settingsDraft.peers.push({ name: "Windows 电脑", address: "", token: "", enabled: true }); renderPeerEditor(); };
document.querySelector("#addSourceButton").onclick = () => { readSettingsForm(); state.settingsDraft.sources.push({ name: `数据源 ${state.settingsDraft.sources.length + 1}`, path: "", enabled: true }); renderSourceEditor(); };
document.querySelector("#sourceEditor").onclick = async (event) => {
  const choose = event.target.closest("[data-choose-source]");
  if (!choose) return;
  readSettingsForm();
  const chosen = await desktop.chooseCodexHome();
  if (chosen) state.settingsDraft.sources[Number(choose.dataset.chooseSource)].path = chosen;
  renderSourceEditor();
};
document.querySelector("#regenerateTokenButton").onclick = async () => {
  if (!confirm("重新生成后，其他电脑保存的旧令牌会失效。确定继续吗？")) return;
  const token = await desktop.regenerateToken(); state.settingsDraft.shareToken = token; document.querySelector("#shareTokenText").textContent = token;
};
document.querySelector("#saveSettingsButton").onclick = async () => {
  readSettingsForm();
  const button = document.querySelector("#saveSettingsButton"); button.disabled = true; button.textContent = "正在连接…";
  try {
    const result = await desktop.saveConfig(state.settingsDraft); state.config = result.config; state.snapshot = result.snapshot; closeSettings(); render();
  } catch (error) {
    document.querySelector("#settingsMessage").textContent = error.message;
  } finally { button.disabled = false; button.textContent = "保存并连接"; }
};
window.onresize = () => state.snapshot && render();

if (!desktop) {
  document.querySelector("#loading").innerHTML = "<strong>请从桌面应用启动，不要直接打开 HTML 文件。</strong>";
} else {
  Promise.all([desktop.getUpdateStatus(), load()]).then(([update]) => {
    state.update = update;
    renderUpdateStatus();
    desktop.onUpdateStatus(renderUpdateStatus);
  });
  setInterval(() => {
    if (state.snapshot && document.querySelector("#settingsModal").classList.contains("hidden")) load(true);
  }, 60000);
}
