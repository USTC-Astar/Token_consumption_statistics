const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

const USAGE_KEYS = ["input", "cached", "output", "reasoning", "total"];
const CACHE_VERSION = 11;
const SCHEMA_VERSION = 10;
const EXACT_BREAKDOWN_SCHEMA_VERSION = 4;
const TOKEN_EVENT_SCHEMA_VERSION = 10;

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
  return usageValues(info?.total_token_usage);
}

function lastTokenValues(info) {
  return usageValues(info?.last_token_usage);
}

function usageValues(usage) {
  const value = usage || {};
  const input = Math.max(0, Number(value.input_tokens || 0));
  const cached = Math.max(0, Number(value.cached_input_tokens ?? value.cache_read_input_tokens ?? 0));
  const output = Math.max(0, Number(value.output_tokens || 0));
  const reasoning = Math.max(0, Number(value.reasoning_output_tokens || 0));
  const reportedTotal = Number(value.total_tokens);
  return {
    input,
    cached,
    output,
    reasoning,
    // Codex 的 cached 属于 input、reasoning 属于 output，不能再次加到总量中。
    total: Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : input + output,
  };
}

function usageDelta(current, previous) {
  if (USAGE_KEYS.some((key) => current[key] < previous[key])) return null;
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, current[key] - previous[key]]));
}

function sameUsage(left, right) {
  return USAGE_KEYS.every((key) => Number(left?.[key] || 0) === Number(right?.[key] || 0));
}

function usageWithin(current, baseline) {
  return USAGE_KEYS.every((key) => Number(current?.[key] || 0) <= Number(baseline?.[key] || 0));
}

function looksLikeStaleRegression(current, previous, last) {
  if (!current.total || !previous.total || !last.total) return false;
  // Codex 偶尔会把稍旧的累计快照乱序写入。回退不足约 2%，或差值不超过两次最近增量时，
  // 应忽略这条旧快照；否则下一条恢复到高水位时会把 last_token_usage 重复计算。
  return current.total * 100 >= previous.total * 98 || current.total + last.total * 2 >= previous.total;
}

function addUsageCopy(left, right) {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, Number(left?.[key] || 0) + Number(right?.[key] || 0)]));
}

function uuidV7Timestamp(id) {
  const match = String(id || "").match(/^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : null;
}

function forkParentId(payload) {
  const spawn = payload?.source && typeof payload.source === "object"
    ? payload.source?.subagent?.thread_spawn
    : null;
  return String(payload?.forked_from_id || payload?.parent_thread_id || spawn?.parent_thread_id || "");
}

function forkTaskStartsOwnSession({ childSessionId, turnId, startedAt }) {
  if (!turnId || !childSessionId) return false;
  const childTimestamp = uuidV7Timestamp(childSessionId);
  if (childTimestamp === null) return true;
  const turnTimestamp = uuidV7Timestamp(turnId);
  if (turnTimestamp !== null) return turnTimestamp >= childTimestamp;
  const numericStartedAt = Number(startedAt);
  return Number.isFinite(numericStartedAt) && numericStartedAt >= Math.floor(childTimestamp / 1000);
}

function forkTurnStartsOwnSession({ childSessionId, replaySessionId, turnId, taskStartedTurnIds, isUserFork }) {
  // 没有嵌入父 session_meta 时，日志中的第一个 turn_context 通常就是子会话自己的边界。
  if (!replaySessionId) return true;
  if (!turnId) return true;
  const childTimestamp = uuidV7Timestamp(childSessionId);
  if (childTimestamp === null) return true;
  const turnTimestamp = uuidV7Timestamp(turnId);
  if (turnTimestamp === null) return isUserFork || taskStartedTurnIds.has(turnId);
  if (turnTimestamp > childTimestamp) return true;
  if (turnTimestamp < childTimestamp) return false;
  return isUserFork || taskStartedTurnIds.has(turnId);
}

function tokenEventKey({ scopeId, cumulative, timestamp, usage }) {
  if (cumulative) {
    return `codex:${scopeId}:${cumulative.total}:${cumulative.input}:${cumulative.cached}:${cumulative.output}:${cumulative.reasoning}`;
  }
  return `codex:${scopeId}:${timestamp || "unknown"}:${usage.total}:${usage.input}:${usage.cached}:${usage.output}:${usage.reasoning}`;
}

function declaredModel(rowType, payload) {
  if (rowType === "turn_context") return String(payload?.model || "").trim();
  if (payload?.type !== "thread_settings_applied") return "";
  const settings = payload.thread_settings || {};
  return String(settings.model || settings.collaboration_mode?.settings?.model || "").trim();
}

function moveUnknownUsageToModel(model, models, daily, tokenEvents = []) {
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
  for (const event of tokenEvents) {
    if (event.model === "未知模型") event.model = model;
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
    forkedFromId: String(session?.forkedFromId || ""),
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
  let firstSessionMetaSeen = false;
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
  let forkedFromId = "";
  let forkChildSessionId = "";
  let forkReplaySessionId = "";
  let forkReplayActive = false;
  let forkIsUser = false;
  let forkInheritedBaseline = null;
  let forkInheritedReportedTotal = null;
  let skippedReplayTokenEvents = 0;
  let currentModel = "未知模型";
  let currentTaskStarted = null;
  let activeSeconds = 0;
  let turns = 0;
  let tools = 0;
  let userMessages = 0;
  let hasPreviousUsage = false;
  let previousUsage = emptyUsage();
  let cumulativeTokenStart = null;
  let cumulativeTokenEnd = null;
  const accumulatedUsage = emptyUsage();
  const daily = {};
  const models = {};
  const tokenEvents = [];
  const hours = Array.from({ length: 24 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const weekdays = Array.from({ length: 7 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const toolNames = {};
  const modelTurns = {};
  const forkTaskStartedTurnIds = new Set();
  const forkTaskStarts = new Map();

  const startTask = (parts) => {
    turns += 1;
    currentTaskStarted = parts?.epoch || null;
    if (!parts) return;
    daily[parts.date] ||= emptyBucket();
    daily[parts.date].turns += 1;
    hours[parts.hour].turns += 1;
    weekdays[parts.weekday].turns += 1;
  };

  const applySessionMeta = (payload, timestamp) => {
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
    forkedFromId = forkParentId(payload) || forkedFromId;
    if (forkedFromId && !parentThreadId) parentThreadId = forkedFromId;
    // 子代理日志中的 session_id 指向根任务，而 id 是当前子代理自己的会话 ID。
    if (threadSource === "subagent") rootSessionId = payload.root_thread_id || payload.session_id || forkedFromId || rootSessionId;
  };

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
      if (!firstSessionMetaSeen) {
        applySessionMeta(payload, timestamp);
        firstSessionMetaSeen = true;
        forkChildSessionId = sessionId;
        forkReplayActive = Boolean(forkedFromId);
        forkIsUser = payload.thread_source === "user";
        continue;
      }
      if (forkReplayActive) {
        if (payload.id && payload.id !== forkChildSessionId) forkReplaySessionId = payload.id;
        // fork 文件会嵌入父会话的 session_meta，不能让它覆盖子会话身份、项目和设备信息。
        continue;
      }
      if (!payload.id || payload.id === sessionId) applySessionMeta(payload, timestamp);
      continue;
    }

    if (forkReplayActive) {
      if (payloadType === "task_started" && forkTaskStartsOwnSession({
        childSessionId: forkChildSessionId,
        turnId: payload.turn_id,
        startedAt: payload.started_at,
      })) {
        forkTaskStartedTurnIds.add(payload.turn_id);
        forkTaskStarts.set(payload.turn_id, parts);
      }

      if (row.type === "turn_context" && forkTurnStartsOwnSession({
        childSessionId: forkChildSessionId,
        replaySessionId: forkReplaySessionId,
        turnId: payload.turn_id,
        taskStartedTurnIds: forkTaskStartedTurnIds,
        isUserFork: forkIsUser,
      })) {
        forkReplayActive = false;
        const taskParts = forkTaskStarts.get(payload.turn_id);
        if (taskParts) startTask(taskParts);
        forkTaskStartedTurnIds.clear();
        forkTaskStarts.clear();
      } else {
        if (payloadType === "token_count" && payload.info?.total_token_usage) {
          const inherited = tokenValues(payload.info);
          previousUsage = inherited;
          hasPreviousUsage = true;
          forkInheritedBaseline = inherited;
          const reportedTotal = Number(payload.info.total_token_usage.total_tokens);
          forkInheritedReportedTotal = Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : inherited.total;
          skippedReplayTokenEvents += 1;
        }
        // fork 开头是父线程完整历史的高速重放；turn、工具和 Token 都不能计入子会话。
        continue;
      }
    }

    const model = declaredModel(row.type, payload);
    if (model) {
      // 新版 Codex 的子代理在首个 turn_context 之前就会写入累计 Token，
      // 但 thread_settings_applied 已经给出了实际模型；首次识别时要把这些流量回填过去。
      if (currentModel === "未知模型") moveUnknownUsageToModel(model, models, daily, tokenEvents);
      currentModel = model;
      modelTurns[model] = (modelTurns[model] || 0) + 1;
    }

    if (payloadType === "task_started") {
      startTask(parts);
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
      const totalUsage = payload.info?.total_token_usage ? tokenValues(payload.info) : null;
      const lastUsage = payload.info?.last_token_usage ? lastTokenValues(payload.info) : null;

      if (forkInheritedBaseline) {
        const reportedTotal = Number(payload.info?.total_token_usage?.total_tokens);
        const stillInherited = totalUsage && (
          (Number.isFinite(reportedTotal) && reportedTotal <= forkInheritedReportedTotal)
          || usageWithin(totalUsage, forkInheritedBaseline)
        );
        if (stillInherited) {
          skippedReplayTokenEvents += 1;
          continue;
        }
        // 没有累计值时无法继续比较继承基线，应信任 last_token_usage 作为真实增量。
        forkInheritedBaseline = null;
        forkInheritedReportedTotal = null;
      }

      let delta = null;
      let nextPrevious = hasPreviousUsage ? previousUsage : null;
      if (totalUsage && lastUsage) {
        if (hasPreviousUsage && sameUsage(totalUsage, previousUsage)) continue;
        if (hasPreviousUsage && !usageDelta(totalUsage, previousUsage)
          && looksLikeStaleRegression(totalUsage, previousUsage, lastUsage)) continue;
        // 热门统计项目均把 last_token_usage 当作真实请求增量；累计值仅用于去重和异常检测。
        delta = lastUsage;
        nextPrevious = totalUsage;
      } else if (totalUsage) {
        if (hasPreviousUsage && sameUsage(totalUsage, previousUsage)) continue;
        if (hasPreviousUsage) {
          delta = usageDelta(totalUsage, previousUsage);
          if (!delta) {
            // 缺少 last 时遇到累计重置，只建立新基线，绝不能把整个新累计值再次计入。
            previousUsage = totalUsage;
            continue;
          }
        } else {
          delta = totalUsage;
        }
        nextPrevious = totalUsage;
      } else if (lastUsage) {
        delta = lastUsage;
        nextPrevious = hasPreviousUsage ? addUsageCopy(previousUsage, lastUsage) : null;
      }

      if (!delta || delta.total <= 0) continue;
      if (totalUsage) {
        if (cumulativeTokenStart === null) cumulativeTokenStart = totalUsage.total;
        cumulativeTokenEnd = totalUsage.total;
      }
      previousUsage = nextPrevious || previousUsage;
      hasPreviousUsage = Boolean(nextPrevious) || hasPreviousUsage;

      const scopeId = forkedFromId || sessionId;
      tokenEvents.push({
        key: tokenEventKey({ scopeId, cumulative: totalUsage, timestamp, usage: delta }),
        timestamp,
        model: currentModel,
        ...delta,
      });
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
      forkedFromId,
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
      cumulativeTokenStart,
      cumulativeTokenEnd,
      tokenEventCount: tokenEvents.length,
      skippedReplayTokenEvents,
      ...accumulatedUsage,
    },
    daily,
    models,
    tokenEvents,
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
    tokenEvents: Array.isArray(raw.tokenEvents) ? raw.tokenEvents.map((event) => ({ ...event })) : null,
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
  const eventSchema = Array.isArray(record.tokenEvents) ? 1 : 0;
  // 同一 ID 的快照副本可能总量略大，却把历史累计量全部记在复制当天。
  // 因此优先选择具备事件级明细的新版记录和持续追加的主日志，再比较覆盖天数与完整度。
  return [eventSchema, canonical, activeDays, total, activity, ended];
}

function isRecordNewer(candidate, current) {
  const left = recordRank(candidate);
  const right = recordRank(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function clearBucketUsage(bucket) {
  const result = cloneBucket(bucket);
  for (const key of USAGE_KEYS) result[key] = 0;
  result.models = {};
  result.projects = {};
  result.hours = {};
  return result;
}

function clearTimelineUsage(timeline, length) {
  return cloneUsageTimeline(timeline, length).map((bucket) => {
    for (const key of USAGE_KEYS) bucket[key] = 0;
    return bucket;
  });
}

function rebuildRecordUsage(record, seenTokenEvents) {
  if (!Array.isArray(record.tokenEvents)) return { record, duplicateTokenEvents: 0, acceptedTokenEvents: null };

  const rebuilt = {
    ...record,
    session: { ...record.session },
    daily: Object.fromEntries(Object.entries(record.daily || {}).map(([date, bucket]) => [date, clearBucketUsage(bucket)])),
    models: {},
    tokenEvents: [],
    hours: clearTimelineUsage(record.hours, 24),
    weekdays: clearTimelineUsage(record.weekdays, 7),
    toolNames: { ...(record.toolNames || {}) },
  };
  for (const key of USAGE_KEYS) rebuilt.session[key] = 0;

  let duplicateTokenEvents = 0;
  for (const event of record.tokenEvents) {
    if (event.key && seenTokenEvents.has(event.key)) {
      duplicateTokenEvents += 1;
      continue;
    }
    if (event.key) seenTokenEvents.add(event.key);
    const usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, Number(event?.[key] || 0)]));
    rebuilt.tokenEvents.push({ ...event, ...usage });
    addUsage(rebuilt.session, usage);
    rebuilt.models[event.model || "未知模型"] = (rebuilt.models[event.model || "未知模型"] || 0) + usage.total;
    const parts = localParts(event.timestamp);
    if (!parts) continue;
    rebuilt.daily[parts.date] ||= emptyBucket();
    addUsage(rebuilt.daily[parts.date], usage);
    rebuilt.daily[parts.date].models[event.model || "未知模型"] = (rebuilt.daily[parts.date].models[event.model || "未知模型"] || 0) + usage.total;
    rebuilt.daily[parts.date].hours[parts.hour] = (rebuilt.daily[parts.date].hours[parts.hour] || 0) + usage.total;
    addUsage(rebuilt.hours[parts.hour], usage);
    addUsage(rebuilt.weekdays[parts.weekday], usage);
  }

  rebuilt.session.tokenEventCount = rebuilt.tokenEvents.length;
  rebuilt.session.model = Object.entries(rebuilt.models).sort((left, right) => right[1] - left[1])[0]?.[0]
    || rebuilt.session.model;
  for (const bucket of Object.values(rebuilt.daily)) {
    bucket.projects[rebuilt.session.project] = bucket.total;
  }
  return { record: rebuilt, duplicateTokenEvents, acceptedTokenEvents: rebuilt.tokenEvents.length };
}

function dedupeRecords(records) {
  const uniqueSessions = new Map();
  for (const record of records) {
    const id = record.session?.id;
    if (!id) continue;
    const current = uniqueSessions.get(id);
    if (!current || isRecordNewer(record, current)) uniqueSessions.set(id, record);
  }

  const selected = [...uniqueSessions.values()];
  const claimOrder = [...selected].sort((left, right) => {
    if (isRecordNewer(left, right)) return -1;
    if (isRecordNewer(right, left)) return 1;
    return String(left.session?.id || "").localeCompare(String(right.session?.id || ""));
  });
  const seenTokenEvents = new Set();
  const rebuiltById = new Map();
  let duplicateTokenEvents = 0;
  let fullyDuplicateSessions = 0;
  for (const record of claimOrder) {
    const rebuilt = rebuildRecordUsage(record, seenTokenEvents);
    duplicateTokenEvents += rebuilt.duplicateTokenEvents;
    const hadTokenEvents = Array.isArray(record.tokenEvents) && record.tokenEvents.length > 0;
    const forked = Boolean(record.session?.forkedFromId) || subagentInfo(record.session).isSubagent;
    if (hadTokenEvents && rebuilt.acceptedTokenEvents === 0 && forked) {
      fullyDuplicateSessions += 1;
      continue;
    }
    rebuiltById.set(record.session.id, rebuilt.record);
  }
  const dedupedRecords = selected.map((record) => rebuiltById.get(record.session.id)).filter(Boolean);
  return {
    records: dedupedRecords,
    duplicateSessions: Math.max(0, records.length - selected.length) + fullyDuplicateSessions,
    duplicateTokenEvents,
  };
}

function mergeHourOrWeek(target, source) {
  source.forEach((bucket, index) => {
    addUsage(target[index], bucket);
    target[index].turns += Number(bucket?.turns || 0);
    target[index].tools += Number(bucket?.tools || 0);
  });
}

function compactTokenEvent(event) {
  return [
    event?.key || "",
    event?.timestamp || null,
    event?.model || "未知模型",
    Number(event?.input || 0),
    Number(event?.cached || 0),
    Number(event?.output || 0),
    Number(event?.reasoning || 0),
    Number(event?.total || 0),
  ];
}

function expandTokenEvent(event) {
  if (!Array.isArray(event)) return { ...event };
  return {
    key: event[0] || "",
    timestamp: event[1] || null,
    model: event[2] || "未知模型",
    input: Number(event[3] || 0),
    cached: Number(event[4] || 0),
    output: Number(event[5] || 0),
    reasoning: Number(event[6] || 0),
    total: Number(event[7] || 0),
  };
}

function sessionWithBreakdown(record) {
  return {
    ...record.session,
    breakdown: {
      daily: Object.fromEntries(Object.entries(record.daily || {}).map(([date, bucket]) => [date, cloneBucket(bucket)])),
      models: { ...(record.models || {}) },
      // 远程同步会携带事件级明细；使用定长数组可显著减少 JSON 字段名造成的网络体积。
      tokenEvents: Array.isArray(record.tokenEvents) ? record.tokenEvents.map(compactTokenEvent) : null,
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
    tokenEvents: Array.isArray(session.breakdown.tokenEvents)
      ? session.breakdown.tokenEvents.map(expandTokenEvent)
      : null,
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
    duplicateTokenEvents: deduped.duplicateTokenEvents + Number(metadata.duplicateTokenEvents || 0),
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
  target.duplicateTokenEvents += Number(legacy.duplicateTokenEvents || 0);
}

function combineStatsData(statsRows, metadata = {}) {
  const exactRecords = [];
  const legacyRows = [];
  let tokenEventDedupeLimited = false;
  for (const stats of statsRows.filter(Boolean)) {
    const sessions = stats.sessions || [];
    // 版本 4 已具备会话级日统计，可以在汇总端继续按会话 ID 精确去重。
    const exact = Number(stats.schemaVersion || 0) >= EXACT_BREAKDOWN_SCHEMA_VERSION && sessions.every((session) => session?.breakdown?.daily);
    if (exact) {
      exactRecords.push(...sessions.map(recordFromSession).filter(Boolean));
      if (Number(stats.schemaVersion || 0) < TOKEN_EVENT_SCHEMA_VERSION
        || sessions.some((session) => !Array.isArray(session?.breakdown?.tokenEvents))) tokenEventDedupeLimited = true;
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
    duplicateTokenEvents: statsRows.reduce((sum, stats) => sum + Number(stats?.duplicateTokenEvents || 0), 0),
    dedupeMode: legacyRows.length || tokenEventDedupeLimited ? "partial" : "exact",
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
