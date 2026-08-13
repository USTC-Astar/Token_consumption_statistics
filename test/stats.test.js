const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { scanCodexData, combineStatsData } = require("../src/stats");

function writeSession(codexHome, name, rows) {
  const directory = path.join(codexHome, "sessions", "2026", "08", "12");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function fixtureRows({ id, total, endedAt = "2026-08-12T10:00:03.000Z", meta = {} }) {
  return [
    { timestamp: "2026-08-12T10:00:00.000Z", type: "session_meta", payload: { id, session_id: id, timestamp: "2026-08-12T10:00:00.000Z", cwd: "/work/demo", source: "cli", model_provider: "openai", ...meta } },
    { timestamp: "2026-08-12T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-test" } },
    { timestamp: "2026-08-12T10:00:01.000Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-08-12T10:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: total } } } },
    { timestamp: endedAt, type: "event_msg", payload: { type: "task_complete" } },
  ];
}

test("多个本地目录按会话 ID 去重，并保留更新更完整的副本", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wsl = path.join(root, "wsl");
  const windows = path.join(root, "windows");
  const sharedId = "shared-session";
  writeSession(wsl, "wsl-shared", fixtureRows({ id: sharedId, total: 100, endedAt: "2026-08-12T10:00:03.000Z" }));
  writeSession(windows, "windows-shared", fixtureRows({ id: sharedId, total: 150, endedAt: "2026-08-12T10:00:04.000Z" }));
  writeSession(windows, "windows-only", fixtureRows({ id: "windows-only", total: 50 }));

  const stats = await scanCodexData({
    sources: [
      { id: "wsl", name: "WSL", path: wsl, enabled: true },
      { id: "windows", name: "Windows", path: windows, enabled: true },
    ],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });

  assert.equal(stats.sources.length, 2);
  assert.equal(stats.filesScanned, 3);
  assert.equal(stats.sessions.length, 2);
  assert.equal(stats.duplicateSessions, 1);
  assert.equal(stats.totals.total, 200);
  assert.equal(stats.sessions.find((session) => session.id === sharedId).sourceName, "Windows");
  assert.ok(stats.sessions.every((session) => session.breakdown?.daily));
});

test("新版远程统计在中心端继续按会话 ID 全局去重", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-remote-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localHome = path.join(root, "local");
  const remoteHome = path.join(root, "remote");
  writeSession(localHome, "same", fixtureRows({ id: "same-session", total: 120 }));
  writeSession(remoteHome, "same-newer", fixtureRows({ id: "same-session", total: 180, endedAt: "2026-08-12T10:00:05.000Z" }));
  writeSession(remoteHome, "remote-only", fixtureRows({ id: "remote-only", total: 20 }));

  const local = await scanCodexData({ sources: [{ id: "local", name: "Linux", path: localHome }], cachePath: path.join(root, "local-cache.json"), device: { id: "local-host", name: "本机" } });
  const remote = await scanCodexData({ sources: [{ id: "remote", name: "Windows", path: remoteHome }], cachePath: path.join(root, "remote-cache.json"), device: { id: "remote-host", name: "远程" } });
  const aggregate = combineStatsData([local, remote]);

  assert.equal(aggregate.dedupeMode, "exact");
  assert.equal(aggregate.sessions.length, 2);
  assert.equal(aggregate.totals.total, 200);
  assert.equal(aggregate.duplicateSessions, 1);
  assert.equal(aggregate.sessions.find((session) => session.id === "same-session").deviceName, "远程");
});

test("同一会话优先选择 Token 更完整的副本，而不是盲目选择结束时间更晚的截断日志", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-complete-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const completeHome = path.join(root, "complete");
  const truncatedHome = path.join(root, "truncated");
  writeSession(completeHome, "complete", fixtureRows({ id: "same", total: 300, endedAt: "2026-08-12T10:00:03.000Z" }));
  writeSession(truncatedHome, "truncated", fixtureRows({ id: "same", total: 100, endedAt: "2026-08-12T10:00:10.000Z" }));
  const stats = await scanCodexData({
    sources: [
      { id: "complete", name: "完整", path: completeHome },
      { id: "truncated", name: "截断", path: truncatedHome },
    ],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "主机" },
  });
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.totals.total, 300);
  assert.equal(stats.sessions[0].sourceName, "完整");
});

test("相同会话 ID 优先选择文件名匹配的主日志，避免快照把历史累计量压到当天", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-canonical-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  writeSession(codexHome, "canonical-session", fixtureRows({ id: "canonical-session", total: 300, endedAt: "2026-08-12T10:00:03.000Z" }));
  writeSession(codexHome, "snapshot-copy", fixtureRows({ id: "canonical-session", total: 350, endedAt: "2026-08-12T10:00:10.000Z" }));

  const stats = await scanCodexData({
    sources: [{ id: "local", name: "本机", path: codexHome }],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });

  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0].total, 300);
  assert.equal(stats.sessions[0].isCanonicalLog, true);
  assert.equal(stats.duplicateSessions, 1);
});

test("子代理会话使用代理昵称和任务路径命名，并保留父任务关系", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-agent-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  writeSession(codexHome, "child", fixtureRows({
    id: "child-session",
    total: 200,
    meta: {
      session_id: "parent-session",
      thread_source: "subagent",
      parent_thread_id: "parent-session",
      agent_nickname: "Kant",
      agent_path: "/root/active_slam_audit",
      agent_depth: 1,
      source: { subagent: { thread_spawn: {} } },
    },
  }));

  const stats = await scanCodexData({
    sources: [{ id: "local", name: "本机", path: codexHome }],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });
  const child = stats.sessions.find((session) => session.id === "child-session");
  assert.equal(stats.schemaVersion, 6);
  assert.equal(child.title, "子代理 · Kant · active_slam_audit");
  assert.equal(child.threadSource, "subagent");
  assert.equal(child.parentThreadId, "parent-session");
  assert.equal(child.rootSessionId, "parent-session");
  assert.equal(child.agentNickname, "Kant");
  assert.equal(child.agentTaskName, "active_slam_audit");
});

test("同一根任务存在主会话时，即使子代理快照更大也只保留主会话", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-family-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  writeSession(codexHome, "parent", fixtureRows({ id: "parent-session", total: 300, endedAt: "2026-08-12T10:10:00.000Z" }));
  for (const [id, total, nickname] of [["child-a", 220, "Kant"], ["child-b", 350, "Einstein"]]) {
    writeSession(codexHome, id, fixtureRows({
      id,
      total,
      endedAt: "2026-08-12T10:20:00.000Z",
      meta: {
        session_id: "parent-session",
        thread_source: "subagent",
        parent_thread_id: "parent-session",
        agent_nickname: nickname,
        agent_path: `/root/${id}`,
        source: { subagent: { thread_spawn: {} } },
      },
    }));
  }

  const stats = await scanCodexData({
    sources: [{ id: "local", name: "本机", path: codexHome }],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });

  assert.equal(stats.schemaVersion, 6);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0].id, "parent-session");
  assert.equal(stats.totals.total, 300);
  assert.equal(stats.duplicateSessions, 2);
});

test("根会话日志缺失时，同组子代理保留 Token 最大的一份", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-family-fallback-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  for (const [id, total, endedAt] of [["child-old", 500, "2026-08-12T10:10:00.000Z"], ["child-new", 550, "2026-08-12T10:20:00.000Z"]]) {
    writeSession(codexHome, id, fixtureRows({
      id,
      total,
      endedAt,
      meta: {
        session_id: "missing-parent",
        thread_source: "subagent",
        parent_thread_id: "missing-parent",
        agent_nickname: id,
        agent_path: `/root/${id}`,
        source: { subagent: { thread_spawn: {} } },
      },
    }));
  }

  const stats = await scanCodexData({
    sources: [{ id: "local", name: "本机", path: codexHome }],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });

  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0].id, "child-new");
  assert.equal(stats.totals.total, 550);
  assert.equal(stats.duplicateSessions, 1);
});

test("子代理在 turn_context 前产生的 Token 会归入 thread_settings_applied 声明的模型", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-early-agent-model-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  const meta = {
    session_id: "parent-session",
    thread_source: "subagent",
    parent_thread_id: "parent-session",
    agent_nickname: "Einstein",
    agent_path: "/root/visual_review",
    source: { subagent: { thread_spawn: {} } },
  };
  const rows = fixtureRows({ id: "child-session", total: 200, meta });
  rows.splice(1, 1);
  rows.splice(3, 0,
    { timestamp: "2026-08-12T10:00:02.500Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol" } } },
    { timestamp: "2026-08-12T10:00:02.600Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
  );
  writeSession(codexHome, "child", rows);

  const stats = await scanCodexData({
    sources: [{ id: "local", name: "本机", path: codexHome }],
    cachePath: path.join(root, "cache.json"),
    device: { id: "host", name: "测试电脑" },
  });

  assert.equal(stats.totals.total, 200);
  assert.equal(stats.models["gpt-5.6-sol"], 200);
  assert.equal(stats.models["未知模型"] || 0, 0);
  assert.equal(stats.sessions[0].model, "gpt-5.6-sol");
});

test("版本 4 远程端仍可按会话 ID 去重，但明确提示缺少根任务去重信息", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-traffic-v4-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "remote");
  writeSession(codexHome, "remote", fixtureRows({ id: "remote-session", total: 180 }));
  const remote = await scanCodexData({ sources: [{ id: "remote", name: "远程", path: codexHome }], cachePath: path.join(root, "cache.json"), device: { id: "remote", name: "远程" } });
  remote.schemaVersion = 4;
  const aggregate = combineStatsData([remote]);
  assert.equal(aggregate.dedupeMode, "partial");
  assert.equal(aggregate.sessions.length, 1);
  assert.equal(aggregate.totals.total, 180);
});

test("旧版远程统计明确降级为部分去重，而不是假装精确", () => {
  const legacy = {
    schemaVersion: 3,
    filesScanned: 1,
    daily: [{ date: "2026-08-12", input: 90, cached: 20, output: 10, reasoning: 3, total: 100, turns: 1, tools: 0, sessions: 1, activeSeconds: 2, models: { old: 100 }, projects: { demo: 100 }, devices: { old: 100 }, hours: { 18: 100 }, toolNames: {} }],
    totals: { input: 90, cached: 20, output: 10, reasoning: 3, total: 100, turns: 1, tools: 0, sessions: 1, activeSeconds: 2, models: {}, projects: {}, devices: {}, hours: {}, toolNames: {} },
    models: { old: 100 }, projects: { demo: 100 }, tools: {}, hours: [], weekdays: [], sessions: [{ id: "legacy", total: 100 }],
  };
  const aggregate = combineStatsData([legacy]);
  assert.equal(aggregate.dedupeMode, "partial");
  assert.equal(aggregate.totals.total, 100);
  assert.equal(aggregate.sessions.length, 1);
});
