const assert = require("assert/strict");
const { EventEmitter } = require("events");
const test = require("node:test");

const { UpdateController, updateErrorMessage } = require("../src/updater");

class FakeUpdater extends EventEmitter {
  setFeedURL(value) { this.feed = value; }
  async checkForUpdates() { this.emit("checking-for-update"); }
  async downloadUpdate() { this.emit("download-progress", { percent: 42.5 }); }
  quitAndInstall(silent, forceRunAfter) { this.installed = { silent, forceRunAfter }; }
}

test("安装版能够检查、下载并进入待重启安装状态", async () => {
  const updater = new FakeUpdater();
  const controller = new UpdateController({ updater, appVersion: "2.3.1", platform: "win32", isPackaged: true, openExternal: async () => {} });
  controller.initialize();
  assert.equal(updater.feed.repo, "Token_consumption_statistics");
  await controller.check();
  assert.equal(controller.snapshot().phase, "checking");
  updater.emit("update-available", { version: "2.4.0" });
  assert.equal(controller.snapshot().availableVersion, "2.4.0");
  await controller.download();
  assert.equal(controller.snapshot().phase, "downloading");
  assert.equal(controller.snapshot().percent, 42.5);
  updater.emit("update-downloaded", { version: "2.4.0" });
  assert.equal(controller.snapshot().phase, "downloaded");
});

test("免安装版发现新版时打开主安装版下载页", async () => {
  let opened = "";
  const updater = new FakeUpdater();
  const controller = new UpdateController({ updater, appVersion: "2.3.1", platform: "win32", isPackaged: true, isPortable: true, openExternal: async (url) => { opened = url; } });
  controller.initialize();
  updater.emit("update-available", { version: "2.4.0" });
  assert.equal(controller.snapshot().canAutoInstall, false);
  await controller.download();
  assert.match(opened, /releases\/latest$/);
});

test("GitHub 尚无 Release 时显示可理解的状态", () => {
  assert.equal(updateErrorMessage(new Error("HttpError: 404 Not Found")), "GitHub 尚未发布可用版本");
  assert.equal(updateErrorMessage(new Error("No published versions on GitHub")), "GitHub 尚未发布可用版本");
});
