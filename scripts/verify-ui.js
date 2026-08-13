const { app } = require("electron");
const path = require("path");

// 默认覆盖正式迁移路径；环境变量可指向临时配置，用真实远程数据做无副作用验收。
app.setPath("userData", process.env.CODEX_TRAFFIC_VERIFY_USER_DATA || path.join(app.getPath("appData"), "codex-traffic-studio"));
process.env.CODEX_TRAFFIC_VERIFY_UI = "1";
const desktopMain = require("../src/main");

async function main() {
  await app.whenReady();
  const started = Date.now();
  while (!desktopMain.getMainWindow()) {
    if (Date.now() - started > 10000) throw new Error("等待主窗口创建超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const window = desktopMain.getMainWindow();
  const expectedSubagent = JSON.stringify(process.env.CODEX_TRAFFIC_EXPECT_SUBAGENT || "");
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!document.querySelector("#dashboard").classList.contains("hidden")) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > 30000) {
        clearInterval(timer);
        reject(new Error("等待总览渲染超时"));
      }
    }, 100);
  })`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const expectedSubagent = ${expectedSubagent};
    const groupRows = document.querySelectorAll(".session-group-row").length;
    const firstGroup = document.querySelector("[data-session-group]");
    if (firstGroup) firstGroup.click();
    const expandedSubagentRows = document.querySelectorAll(".subagent-row").length;
    const firstSubagentTitle = document.querySelector(".subagent-row .session-name")?.textContent || "";
    const firstSubagentTag = document.querySelector(".subagent-row .subagent-tag")?.textContent || "";
    if (firstGroup) firstGroup.click();
    let expectedSubagentMatch = "";
    if (expectedSubagent) {
      const search = document.querySelector("#sessionSearch");
      search.value = expectedSubagent;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expectedSubagentMatch = document.querySelector(".subagent-row .session-name")?.textContent || "";
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector("#settingsButton").click();
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!document.querySelector("#settingsModal").classList.contains("hidden")) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error("等待设置弹窗超时"));
        }
      }, 100);
    });
    return {
      title: document.title,
      sourceOptions: [...document.querySelectorAll("#devicePicker option")].map((item) => item.textContent),
      sourceCards: [...document.querySelectorAll(".source-card")].map((card) => ({
        name: card.querySelector('[data-field="name"]').value,
        path: card.querySelector('[data-field="path"]').value,
        enabled: card.querySelector('[data-field="enabled"]').checked,
      })),
      metricCards: document.querySelectorAll("#metricCards .metric").length,
      sessionRows: document.querySelectorAll("#sessionRows tr").length,
      groupRows,
      expandedSubagentRows,
      firstSubagentTitle,
      firstSubagentTag,
      expectedSubagent,
      expectedSubagentMatch,
      subtitle: document.querySelector("#subtitle").textContent,
      settingsVisible: !document.querySelector("#settingsModal").classList.contains("hidden"),
      rendererErrors: window.__verificationErrors || [],
    };
  })()`);
  if (result.rendererErrors.length) throw new Error(`渲染进程错误：${result.rendererErrors.join("；")}`);
  if (result.sourceCards.length < 1 || result.metricCards !== 8 || !result.settingsVisible) throw new Error("界面关键区域未完整渲染");
  if (result.groupRows && (!result.expandedSubagentRows || result.firstSubagentTag !== "子代理" || !result.firstSubagentTitle)) throw new Error("子代理父任务分组没有正确展开或命名");
  if (result.expectedSubagent && !result.expectedSubagentMatch.includes(result.expectedSubagent)) throw new Error(`没有找到预期子代理：${result.expectedSubagent}`);
  const shared = desktopMain.statsForSharing({
    codexHome: "/secret/root",
    sessions: [{ id: "sample", sourcePath: "/secret/root" }],
    sources: [{ id: "source", name: "示例", path: "/secret/root", data: { codexHome: "/secret/root", sessions: [{ id: "sample", sourcePath: "/secret/root" }] } }],
  });
  if (JSON.stringify(shared).includes("/secret/root")) throw new Error("远程同步结果仍包含本地 .codex 根目录路径");
  console.log(JSON.stringify(result, null, 2));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
