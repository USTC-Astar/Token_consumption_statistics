const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

const USAGE_KEYS = ["input", "cached", "output", "reasoning", "total"];

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
  for (const key of USAGE_KEYS) target[key] += Number(usage[key] || 0);
}

function addBucket(target, source) {
  addUsage(target, source);
  for (const key of ["turns", "tools", "sessions", "activeSeconds"]) {
    target[key] += Number(source[key] || 0);
  }
  addNumberMap(target.models, source.models);
  addNumberMap(target.projects, source.projects);
  addNumberMap(target.devices, source.devices);
  addNumberMap(target.hours, source.hours);
  addNumberMap(target.toolNames, source.toolNames);
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
      // 单行损坏不应导致整次统计失败；Codex 仍可能正在写入当前日志。
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

async function parseSessionFile(filePath, device) {
  let sessionId = path.basename(filePath, ".jsonl");
  let startedAt = null;
  let endedAt = null;
  let cwd = "";
  let source = "";
  let provider = "";
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
    } else if (row.type === "turn_context") {
      currentModel = payload.model || currentModel;
      modelTurns[currentModel] = (modelTurns[currentModel] || 0) + 1;
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
    bucket.devices[device.id] = (bucket.devices[device.id] || 0) + bucket.total;
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
      startedAt,
      endedAt,
      date: startParts?.date || null,
      cwd,
      project,
      source,
      provider,
      model: dominantModel,
      turns,
      tools,
      userMessages,
      activeSeconds,
      wallSeconds,
      deviceId: device.id,
      deviceName: device.name,
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
    return { version: 3, files: {} };
  }
}

function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
  fs.renameSync(temporary, cachePath);
}

function mergeHourOrWeek(target, source) {
  source.forEach((bucket, index) => {
    addUsage(target[index], bucket);
    target[index].turns += bucket.turns || 0;
    target[index].tools += bucket.tools || 0;
  });
}

async function scanCodexData({ codexHome, cachePath, device }) {
  const started = Date.now();
  const titles = await readTitles(codexHome);
  const files = collectSessionFiles(codexHome);
  const cache = loadCache(cachePath);
  if (cache.version !== 3) cache.files = {};
  cache.version = 3;
  const nextFiles = {};
  const parsed = [];
  let reparsedFiles = 0;

  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    let result = cache.files[filePath]?.signature === signature ? cache.files[filePath].result : null;
    if (!result) {
      result = await parseSessionFile(filePath, device);
      reparsedFiles += 1;
    }
    nextFiles[filePath] = { signature, result };
    parsed.push(result);
  }
  cache.files = nextFiles;
  saveCache(cachePath, cache);

  // 会话被归档时可能短暂同时出现在两个目录，按 session id 去重可以避免重复流量。
  const unique = new Map();
  for (const result of parsed) {
    const current = unique.get(result.session.id);
    if (!current || String(result.session.endedAt || "") > String(current.session.endedAt || "")) {
      unique.set(result.session.id, result);
    }
  }

  const daily = {};
  const models = {};
  const projects = {};
  const tools = {};
  const hours = Array.from({ length: 24 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const weekdays = Array.from({ length: 7 }, () => ({ ...emptyUsage(), turns: 0, tools: 0 }));
  const sessions = [];

  for (const result of unique.values()) {
    result.session.title = titles[result.session.id] || "未命名会话";
    sessions.push(result.session);
    for (const [date, bucket] of Object.entries(result.daily)) {
      daily[date] ||= emptyBucket();
      addBucket(daily[date], bucket);
    }
    addNumberMap(models, result.models);
    projects[result.session.project] = (projects[result.session.project] || 0) + result.session.total;
    addNumberMap(tools, result.toolNames);
    mergeHourOrWeek(hours, result.hours);
    mergeHourOrWeek(weekdays, result.weekdays);
  }

  sessions.sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  const dailyRows = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, ...bucket }));
  const totals = dailyRows.reduce((sum, row) => {
    addBucket(sum, row);
    return sum;
  }, emptyBucket());

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    scanSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    filesScanned: files.length,
    reparsedFiles,
    codexHome,
    device: { ...device, platform: process.platform, hostname: os.hostname() },
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

module.exports = { scanCodexData, emptyBucket, addBucket, addNumberMap };
