const http = require("http");
const crypto = require("crypto");

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

class SyncServer {
  constructor(statsProvider) {
    this.statsProvider = statsProvider;
    this.server = null;
    this.address = null;
  }

  async start({ host, port, token }) {
    await this.stop();
    if (!host || !token) return null;
    this.server = http.createServer(async (request, response) => {
      const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method !== "GET" || request.url !== "/api/v1/stats" || !safeTokenEqual(bearer, token)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const data = await this.statsProvider();
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), data });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    this.address = `http://${host}:${port}`;
    return this.address;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.address = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { SyncServer };
