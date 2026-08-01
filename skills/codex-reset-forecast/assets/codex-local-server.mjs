import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["codex.html", "text/html; charset=utf-8"]],
  ["/codex.html", ["codex.html", "text/html; charset=utf-8"]],
  ["/codex-reset-forecast.json", ["codex-reset-forecast.json", "application/json; charset=utf-8"]],
]);
let remainingRequests = Number(process.env.CODEX_FORECAST_MAX_REQUESTS || 0);

const server = http.createServer((request, response) => {
  if (remainingRequests > 0) response.on("finish", () => {
    remainingRequests -= 1;
    if (remainingRequests === 0) server.close();
  });
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const entry = files.get(pathname);
  if (!entry) { response.writeHead(404); response.end("Not found"); return; }
  const [fileName, contentType] = entry;
  try {
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(fs.readFileSync(path.join(directory, fileName)));
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});

const requestedPort = Number(process.env.CODEX_FORECAST_PORT || 0);
server.listen(Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/codex.html`;
  console.log(`Codex Reset Forecast: ${url}`);
  if (process.env.CODEX_FORECAST_NO_OPEN !== "1") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
