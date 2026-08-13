const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

const USAGE_KEYS = ["input", "cached", "output", "reasoning", "total"];
const CACHE_VERSION = 7;
const SCHEMA_VERSION = 6;
const EXACT_BREAKDOWN_SCHEMA_VERSION = 4;
const FAMILY_DEDUPE_SCHEMA_VERSION = 5;

function emptyUsage() {
  return { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
}

function emptyBucket() {
  return {
    ...emptyUsage(),
    turns: 0,
    tools: 0,
    sessions: 0,
    activeSeconds: 0,
    models: {},
    projects: {},
    devices: {},
    hours: {},
    toolNames: {},
  };
}

function addNumberMap(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function addUsage(target, usage) {
  for (const key of USAGE_KEYS) target[key] += Number(usage?.[key] || 0);
}

function addBucket(target, source) {
  addUsage(target, source);
  for (const key of ["turns", "tools", "sessions", "activeSeconds"]) {
    target[key] += Number(source?.[key] || 0);
  }
  addNumberMap(target.models, source?.models);
  addNumberMap(target.projects, source?.projects);
  addNumberMap(target.devices, source?.devices);
  addNumberMap(target.hours, source?.hours);
  addNumberMap(target.toolNames, source?.toolNames);
}

function cloneBucket(bucket) {
  return {
    ...emptyBucket(),
    ...Object.fromEntries(USAGE_KEYS.map((key) => [key, Number(bucket?.[key] || 0)])),
    turns: Number(bucket?.turns || 0),
    tools: Number(bucket?.tools || 0),
    sessions: Number(bucket?.sessions || 0),
    activeSeconds: Number(bucket?.activeSeconds || 0),
    models: { ...(bucket?.models || {}) },
    projects: { ...(bucket?.projects || {}) },
    devices: { ...(bucket?.devices || {}) },
    hours: { ...(bucket?.hours || {}) },
    toolNames: { ...(bucket?.toolNames || {}) },
  };
}

function cloneUsageTimeline(timeline, length) {
  return Array.from({ length }, (_, index) => ({
    ...emptyUsage(),
    ...(timeline?.[index] || {}),
    turns: Number(timeline?.[index]?.turns || 0),
    tools: Number(timeline?.[index]?.tools || 0),
  }));
}

function tokenValues(info) {
  const usage = info?.total_token_usage || {};
  return {
    input: Number(usage.input_tokens || 0),
    cached: Number(usage.cached_input_tokens || 0),
    output: Number(usage.output_tokens || 0),
    reasoning: Number(usage.reasoning_output_tokens || 0),
    total: Number(usage.total_tokens || 0),
  };
}

function usageDelta(current, previous) {
  // Codex 日志记录的是“会话累计值”。只有做相邻差分，才不会把同一批 Token 重复统计。
  if (current.total < previous.total) return { ...current };
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, Math.max(0, current[key] - previous[key])]));
}

function declaredModel(rowType, payload) {
  if (rowType === "turn_context") return String(payload?.model || "").trim();
  if (payload?.type !== "thread_settings_applied") return "";
  const settings = payload.thread_settings || {};
  return String(settings.model || settings.collaboration_mode?.settings?.model || "").trim();
}

function moveUnknownUsageToModel(model, models, daily) {
  if (!model || model === "未知模型") return;
  const unknownTotal = Number(models["未知模型"] || 0);
  if (unknownTotal > 0) {
    models[model] = (models[model] || 0) + unknownTotal;
    delete models["未知模型"];
  }
  for (const bucket of Object.values(daily)) {
    const unknownDaily = Number(bucket.models?.["未知模型"] || 0);
    if (unknownDaily <= 0) continue;
    bucket.models[model] = (bucket.models[model] || 0) + unknownDaily;
    delete bucket.models["未知模型"];
  }
}

function localParts(timestamp) {
  const value = new Date(timestamp);
  if (!timestamp || Number.isNaN(value.getTime())) return null;
  return {
    date: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`,
    hour: value.getHours(),
    weekday: value.getDay(),
    epoch: value.getTime(),
  };
}

function projectName(cwd) {
  if (!cwd) return "未知项目";
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.includes("\\") ? path.win32.basename(normalized) : path.basename(normalized);
}

function taskNameFromAgentPath(agentPath) {
  return String(agentPath || "").split("/").filter(Boolean).at(-1) || "";
}

function subagentInfo(session) {
  const spawn = session?.source && typeof session.source === "object"
    ? session.source?.subagent?.thread_spawn
    : null;
  const agentPath = String(session?.agentPath || spawn?.agent_path || "");
  const isSubagent = session?.threadSource === "subagent" || Boolean(spawn);
  return {
    isSubagent,
    threadSource: isSubagent ? "subagent" : String(session?.threadSource || "user"),
    parentThreadId: String(session?.parentThreadId || spawn?.parent_thread_id || ""),
    rootSessionId: String(session?.rootSessionId || ""),
    agentNickname: String(session?.agentNickname || spawn?.agent_nickname || ""),
    agentPath,
    agentTaskName: String(session?.agentTaskName || taskNameFromAgentPath(agentPath)),
    agentRole: String(session?.agentRole || spawn?.agent_role || ""),
    agentDepth: Number(session?.agentDepth ?? spawn?.depth ?? (isSubagent ? 1 : 0)),
  };
}

function sessionTitle(session, indexedTitle) {
  const agent = subagentInfo(session);
  if (agent.isSubagent) {
    const parts = ["子代理", agent.agentNickname, agent.agentTaskName].filter(Boolean);
    if (parts.length > 1) return parts.join(" · ");
  }
  return indexedTitle || "未命名会话";
}

async function readTitles(codexHome) {
  const titles = {};
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) return titles;
  const input = fs.createReadStream(indexPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.id) titles[row.id] = row.thread_name || "未命名会话";
    } catch {
      // Codex 可能正在写入索引；单行暂时不完整时跳过，不中断其他日志统计。
    }
  }
  return titles;
}

function collectSessionFiles(codexHome) {
  const files = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  };
  walk(path.join(codexHome, "sessions"));
  walk(path.join(codexHome, "archived_sessions"));
  return files.sort();
}

async function parseSessionFile(filePath) {
  const fileName = path.basename(filePath, ".jsonl");
  let sessionId = fileName;
  let startedAt = null;
  let endedAt = null;
  let cwd = "";
  let source = "";
  let provider = "";
  let threadSource = "user";
  let parentThreadId = "";
  let rootSessionId = "";
  let agentNickname = "";
  let agentPath = "";
  let agentRole = "";
  let agentDepth = 0;
  let currentModel = "未知模型";
  let currentTaskStarted = null;
  let activeSeconds = 0;
  let turns = 0;
  let tools = 0;
  let userMessages = 0;
  let previousUsage = emptyUsage();
  const accumulatedUsage = emptyUsage();
  const daily = {};
  const models = {};
  const hours = Array.from({ length: 24 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const weekdays = Array.from({ length: 7 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const toolNames = {};
  const modelTurns = {};

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = row.timestamp;
    const parts = localParts(timestamp);
    if (timestamp) endedAt = timestamp;
    const payload = row.payload || {};
    const payloadType = payload.type;

    if (row.type === "session_meta") {
      sessionId = payload.id || payload.session_id || sessionId;
      startedAt = payload.timestamp || timestamp || startedAt;
      cwd = payload.cwd || cwd;
      source = payload.source || source;
      provider = payload.model_provider || provider;
      const spawn = payload.source && typeof payload.source === "object"
        ? payload.source?.subagent?.thread_spawn
        : null;
      threadSource = payload.thread_source || (spawn ? "subagent" : threadSource);
      parentThreadId = payload.parent_thread_id || spawn?.parent_thread_id || parentThreadId;
      agentNickname = payload.agent_nickname || spawn?.agent_nickname || agentNickname;
      agentPath = payload.agent_path || spawn?.agent_path || agentPath;
      agentRole = payload.agent_role || spawn?.agent_role || agentRole;
      agentDepth = Number(payload.agent_depth ?? spawn?.depth ?? agentDepth);
      // 子代理日志中的 session_id 指向根任务，而 id 是当前子代理自己的会话 ID。
      if (threadSource === "subagent") rootSessionId = payload.root_thread_id || payload.session_id || rootSessionId;
    }

    const model = declaredModel(row.type, payload);
    if (model) {
      // 新版 Codex 的子代理在首个 turn_context 之前就会写入累计 Token，
      // 但 thread_settings_applied 已经给出了实际模型；首次识别时要把这些流量回填过去。
      if (currentModel === "未知模型") moveUnknownUsageToModel(model, models, daily);
      currentModel = model;
      modelTurns[model] = (modelTurns[model] || 0) + 1;
    }

    if (payloadType === "task_started") {
      turns += 1;
      currentTaskStarted = parts?.epoch || null;
      if (parts) {
        daily[parts.date] ||= emptyBucket();
        daily[parts.date].turns += 1;
        hours[parts.hour].turns += 1;
        weekdays[parts.weekday].turns += 1;
      }
    } else if (payloadType === "task_complete" || payloadType === "turn_aborted") {
      if (currentTaskStarted && parts?.epoch && parts.epoch >= currentTaskStarted) {
        const duration = Math.round((parts.epoch - currentTaskStarted) / 1000);
        activeSeconds += duration;
        daily[parts.date] ||= emptyBucket();
        daily[parts.date].activeSeconds += duration;
      }
      currentTaskStarted = null;
    } else if (payloadType === "user_message") {
      userMessages += 1;
    } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      tools += 1;
      const name = payload.name || "其他工具";
      toolNames[name] = (toolNames[name] || 0) + 1;
      if (parts) {
        daily[parts.date] ||= emptyBucket();
        daily[parts.date].tools += 1;
        daily[parts.date].toolNames[name] = (daily[parts.date].toolNames[name] || 0) + 1;
        hours[parts.hour].tools += 1;
        weekdays[parts.weekday].tools += 1;
      }
    } else if (payloadType === "token_count") {
      const current = tokenValues(payload.info);
      const delta = usageDelta(current, previousUsage);
      addUsage(accumulatedUsage, delta);
      models[currentModel] = (models[currentModel] || 0) + delta.total;
      if (parts) {
        daily[parts.date] ||= emptyBucket();
        addUsage(daily[parts.date], delta);
        daily[parts.date].models[currentModel] = (daily[parts.date].models[currentModel] || 0) + delta.total;
        daily[parts.date].hours[parts.hour] = (daily[parts.date].hours[parts.hour] || 0) + delta.total;
        addUsage(hours[parts.hour], delta);
        addUsage(weekdays[parts.weekday], delta);
      }
      previousUsage = current;
    }
  }

  const startParts = localParts(startedAt || endedAt);
  const endParts = localParts(endedAt);
  const project = projectName(cwd);
  if (startParts) daily[startParts.date] ||= emptyBucket();
  if (startParts) daily[startParts.date].sessions += 1;
  for (const bucket of Object.values(daily)) {
    bucket.projects[project] = (bucket.projects[project] || 0) + bucket.total;
  }
  if (currentTaskStarted && endParts?.epoch >= currentTaskStarted) {
    const duration = Math.round((endParts.epoch - currentTaskStarted) / 1000);
    activeSeconds += duration;
    daily[endParts.date] ||= emptyBucket();
    daily[endParts.date].activeSeconds += duration;
  }

  const dominantModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]
    || Object.entries(modelTurns).sort((a, b) => b[1] - a[1])[0]?.[0]
    || currentModel;
  const wallSeconds = startParts && endParts ? Math.max(0, Math.round((endParts.epoch - startParts.epoch) / 1000)) : 0;

  return {
    session: {
      id: sessionId,
      // Codex 恢复或派生线程时可能复制旧 session_meta，但文件名会换成新线程 ID。
      // 文件名仍以当前会话 ID 结尾的记录才是持续追加的主日志，日分布也最完整。
      isCanonicalLog: fileName.endsWith(sessionId),
      startedAt,
      endedAt,
      date: startParts?.date || null,
      cwd,
      project,
      source,
      provider,
      threadSource,
      parentThreadId,
      rootSessionId,
      agentNickname,
      agentPath,
      agentTaskName: taskNameFromAgentPath(agentPath),
      agentRole,
      agentDepth,
      model: dominantModel,
      turns,
      tools,
      userMessages,
      activeSeconds,
      wallSeconds,
      ...accumulatedUsage,
    },
    daily,
    models,
    hours,
    weekdays,
    toolNames,
  };
}

function loadCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return { version: CACHE_VERSION, files: {} };
  }
}

function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
  fs.renameSync(temporary, cachePath);
}

function normalizeSources({ sources, codexHome }) {
  const input = Array.isArray(sources) && sources.length
    ? sources
    : [{ id: "default", name: "本机 Codex", path: codexHome || path.join(os.homedir(), ".codex"), enabled: true }];
  const seen = new Set();
  return input.filter((source) => source?.enabled !== false).map((source, index) => {
    const rawPath = String(source.path || source.codexHome || "").trim();
    if (!rawPath) return null;
    const sourcePath = path.resolve(rawPath);
    const pathKey = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    if (!sourcePath || seen.has(pathKey)) return null;
    seen.add(pathKey);
    return {
      id: String(source.id || `source-${index + 1}`),
      name: String(source.name || `数据源 ${index + 1}`),
      path: sourcePath,
      enabled: true,
    };
  }).filter(Boolean);
}

function decorateResult(raw, source, device, title) {
  const originId = `${device.id}:${source.id}`;
  const originName = `${device.name} · ${source.name}`;
  const daily = Object.fromEntries(Object.entries(raw.daily || {}).map(([date, value]) => {
    const bucket = cloneBucket(value);
    // 这个映射只用于判断一天内有多少来源活跃；零 Token 会话也应被视为活跃。
    const activity = Math.max(bucket.total, bucket.sessions, bucket.turns, bucket.tools);
    if (activity > 0) bucket.devices[originId] = activity;
    return [date, bucket];
  }));
  return {
    session: {
      ...raw.session,
      ...subagentInfo(raw.session),
      title: sessionTitle(raw.session, title),
      deviceId: device.id,
      deviceName: device.name,
      sourceId: source.id,
      sourceName: source.name,
      sourcePath: source.path,
      originId,
      originName,
    },
    daily,
    models: { ...(raw.models || {}) },
    hours: cloneUsageTimeline(raw.hours, 24),
    weekdays: cloneUsageTimeline(raw.weekdays, 7),
    toolNames: { ...(raw.toolNames || {}) },
  };
}

function recordRank(record) {
  const ended = Date.parse(record.session?.endedAt || "") || 0;
  const total = Number(record.session?.total || 0);
  const activity = Number(record.session?.turns || 0) + Number(record.session?.tools || 0);
  const activeDays = Object.values(record.daily || {}).filter((bucket) => Number(bucket?.total || 0) > 0).length;
  const canonical = record.session?.isCanonicalLog ? 1 : 0;
  // 同一 ID 的快照副本可能总量略大，却把历史累计量全部记在复制当天。
  // 因此优先选择持续追加的主日志，其次比较覆盖天数、Token、活动记录和结束时间。
  return [canonical, activeDays, total, activity, ended];
}

function isRecordNewer(candidate, current) {
  const left = recordRank(candidate);
  const right = recordRank(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function sessionFamilyId(record) {
  const session = record.session || {};
  const agent = subagentInfo(session);
  // 新版 Codex 的主会话和子代理会写入同一份线程累计 Token。
  // 因此 rootSessionId 相同的记录不是可相加的独立用量，而是同一累计值在不同线程中的镜像。
  return String(agent.rootSessionId || (agent.isSubagent ? agent.parentThreadId : "") || session.id || "");
}

function isPrimaryFamilyRecord(record, familyId) {
  const session = record.session || {};
  return !subagentInfo(session).isSubagent && String(session.id || "") === familyId;
}

function isFamilyRecordBetter(candidate, current, familyId) {
  const candidatePrimary = isPrimaryFamilyRecord(candidate, familyId);
  const currentPrimary = isPrimaryFamilyRecord(current, familyId);
  // 主会话已经包含整棵子代理树的线程累计 Token；存在主会话时不能再用子代理镜像替代它。
  if (candidatePrimary !== currentPrimary) return candidatePrimary;
  return isRecordNewer(candidate, current);
}

function dedupeRecords(records) {
  const uniqueSessions = new Map();
  for (const record of records) {
    const id = record.session?.id;
    if (!id) continue;
    const current = uniqueSessions.get(id);
    if (!current || isRecordNewer(record, current)) uniqueSessions.set(id, record);
  }

  const uniqueFamilies = new Map();
  for (const record of uniqueSessions.values()) {
    const familyId = sessionFamilyId(record);
    if (!familyId) continue;
    const current = uniqueFamilies.get(familyId);
    // 同一根任务优先保留主会话；主会话缺失时，才在子代理中选择最完整的一份。
    if (!current || isFamilyRecordBetter(record, current, familyId)) uniqueFamilies.set(familyId, record);
  }
  return {
    records: [...uniqueFamilies.values()],
    duplicateSessions: Math.max(0, records.length - uniqueFamilies.size),
  };
}

function mergeHourOrWeek(target, source) {
  source.forEach((bucket, index) => {
    addUsage(target[index], bucket);
    target[index].turns += Number(bucket?.turns || 0);
    target[index].tools += Number(bucket?.tools || 0);
  });
}

function sessionWithBreakdown(record) {
  return {
    ...record.session,
    breakdown: {
      daily: Object.fromEntries(Object.entries(record.daily || {}).map(([date, bucket]) => [date, cloneBucket(bucket)])),
      models: { ...(record.models || {}) },
      hours: cloneUsageTimeline(record.hours, 24),
      weekdays: cloneUsageTimeline(record.weekdays, 7),
      toolNames: { ...(record.toolNames || {}) },
    },
  };
}

function recordFromSession(session) {
  if (!session?.breakdown?.daily) return null;
  return {
    session: { ...session, breakdown: undefined },
    daily: Object.fromEntries(Object.entries(session.breakdown.daily).map(([date, bucket]) => [date, cloneBucket(bucket)])),
    models: { ...(session.breakdown.models || {}) },
    hours: cloneUsageTimeline(session.breakdown.hours, 24),
    weekdays: cloneUsageTimeline(session.breakdown.weekdays, 7),
    toolNames: { ...(session.breakdown.toolNames || {}) },
  };
}

function summarizeRecords(records, metadata = {}) {
  const deduped = dedupeRecords(records);
  const daily = {};
  const models = {};
  const projects = {};
  const tools = {};
  const hours = Array.from({ length: 24 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const weekdays = Array.from({ length: 7 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const sessions = [];

  for (const record of deduped.records) {
    sessions.push(sessionWithBreakdown(record));
    for (const [date, bucket] of Object.entries(record.daily || {})) {
      daily[date] ||= emptyBucket();
      addBucket(daily[date], bucket);
    }
    addNumberMap(models, record.models);
    projects[record.session.project] = (projects[record.session.project] || 0) + Number(record.session.total || 0);
    addNumberMap(tools, record.toolNames);
    mergeHourOrWeek(hours, record.hours || []);
    mergeHourOrWeek(weekdays, record.weekdays || []);
  }

  sessions.sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  const dailyRows = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, ...bucket }));
  const totals = dailyRows.reduce((sum, row) => {
    addBucket(sum, row);
    return sum;
  }, emptyBucket());

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scanSeconds: Number(metadata.scanSeconds || 0),
    filesScanned: Number(metadata.filesScanned || 0),
    reparsedFiles: Number(metadata.reparsedFiles || 0),
    duplicateSessions: deduped.duplicateSessions + Number(metadata.duplicateSessions || 0),
    dedupeMode: metadata.dedupeMode || "exact",
    codexHome: metadata.codexHome || metadata.source?.path || "",
    device: metadata.device || null,
    source: metadata.source || null,
    totals,
    daily: dailyRows,
    models,
    projects,
    tools,
    hours,
    weekdays,
    sessions,
  };
}

function mergeLegacyStats(target, legacy) {
  const rows = Object.fromEntries(target.daily.map((row) => [row.date, cloneBucket(row)]));
  for (const row of legacy.daily || []) {
    rows[row.date] ||= emptyBucket();
    addBucket(rows[row.date], row);
  }
  target.daily = Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, ...bucket }));
  target.totals = target.daily.reduce((sum, row) => { addBucket(sum, row); return sum; }, emptyBucket());
  addNumberMap(target.models, legacy.models);
  addNumberMap(target.projects, legacy.projects);
  addNumberMap(target.tools, legacy.tools);
  mergeHourOrWeek(target.hours, legacy.hours || []);
  mergeHourOrWeek(target.weekdays, legacy.weekdays || []);
  const sessions = new Map(target.sessions.map((session) => [session.id, session]));
  for (const session of legacy.sessions || []) {
    const current = sessions.get(session.id);
    if (!current || String(session.endedAt || "") > String(current.endedAt || "")) sessions.set(session.id, session);
  }
  target.sessions = [...sessions.values()].sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  target.filesScanned += Number(legacy.filesScanned || 0);
  target.reparsedFiles += Number(legacy.reparsedFiles || 0);
  target.duplicateSessions += Number(legacy.duplicateSessions || 0);
}

function combineStatsData(statsRows, metadata = {}) {
  const exactRecords = [];
  const legacyRows = [];
  let familyDedupeLimited = false;
  for (const stats of statsRows.filter(Boolean)) {
    const sessions = stats.sessions || [];
    // 版本 4 已有会话级日统计，可以按会话 ID 去重；版本 5 才包含根会话关系，能继续消除子代理累计镜像。
    const exact = Number(stats.schemaVersion || 0) >= EXACT_BREAKDOWN_SCHEMA_VERSION && sessions.every((session) => session?.breakdown?.daily);
    if (exact) {
      exactRecords.push(...sessions.map(recordFromSession).filter(Boolean));
      if (Number(stats.schemaVersion || 0) < FAMILY_DEDUPE_SCHEMA_VERSION) familyDedupeLimited = true;
    } else {
      // 旧版远程端没有会话级日统计，无法安全地从总数中减掉重复会话，只能兼容性相加。
      legacyRows.push(stats);
    }
  }
  const result = summarizeRecords(exactRecords, {
    ...metadata,
    filesScanned: statsRows.reduce((sum, stats) => sum + Number(stats?.filesScanned || 0), 0),
    reparsedFiles: statsRows.reduce((sum, stats) => sum + Number(stats?.reparsedFiles || 0), 0),
    duplicateSessions: statsRows.reduce((sum, stats) => sum + Number(stats?.duplicateSessions || 0), 0),
    dedupeMode: legacyRows.length || familyDedupeLimited ? "partial" : "exact",
  });
  for (const legacy of legacyRows) mergeLegacyStats(result, legacy);
  return result;
}

async function scanCodexData({ sources, codexHome, cachePath, device }) {
  const started = Date.now();
  const normalizedSources = normalizeSources({ sources, codexHome });
  const cache = loadCache(cachePath);
  if (cache.version !== CACHE_VERSION) cache.files = {};
  cache.version = CACHE_VERSION;
  const nextFiles = {};
  const allRecords = [];
  const sourceRows = [];
  let reparsedFiles = 0;
  let filesScanned = 0;

  for (const source of normalizedSources) {
    const available = fs.existsSync(source.path) && fs.statSync(source.path).isDirectory();
    const titles = available ? await readTitles(source.path) : {};
    const files = available ? collectSessionFiles(source.path) : [];
    const sourceRecords = [];
    let sourceReparsedFiles = 0;

    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      let raw = cache.files[filePath]?.signature === signature ? cache.files[filePath].result : null;
      if (!raw) {
        raw = await parseSessionFile(filePath);
        reparsedFiles += 1;
        sourceReparsedFiles += 1;
      }
      nextFiles[filePath] = { signature, result: raw };
      sourceRecords.push(decorateResult(raw, source, device, titles[raw.session.id]));
    }

    filesScanned += files.length;
    allRecords.push(...sourceRecords);
    const sourceData = summarizeRecords(sourceRecords, {
      device: { ...device, platform: process.platform, hostname: os.hostname() },
      source,
      codexHome: source.path,
      filesScanned: files.length,
      reparsedFiles: sourceReparsedFiles,
    });
    sourceRows.push({ ...source, available, data: sourceData });
  }

  cache.files = nextFiles;
  saveCache(cachePath, cache);

  const combined = summarizeRecords(allRecords, {
    device: { ...device, platform: process.platform, hostname: os.hostname() },
    codexHome: normalizedSources[0]?.path || "",
    filesScanned,
    reparsedFiles,
    scanSeconds: (Date.now() - started) / 1000,
  });
  combined.sources = sourceRows;
  return combined;
}

module.exports = {
  scanCodexData,
  combineStatsData,
  summarizeRecords,
  emptyBucket,
  addBucket,
  addNumberMap,
};
