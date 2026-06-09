/*
 * 世界杯胜率预测 · 共享缓存代理服务器
 * ------------------------------------------------------------
 * 作用：统一向 API-Football 取数并缓存，所有前端用户读本服务器，
 *       使「官方调用次数与用户数量解耦」——N 个用户在同一缓存窗口内
 *       的请求只触发 1 次官方调用。API key 只保存在服务器端。
 *
 * 运行：Node.js >= 18（自带 fetch）。零依赖，直接 `node server.js`。
 * 环境变量：
 *   API_KEY    （必填）你的 API-Football key
 *   PORT       （默认 8787）
 *   DAILY_CAP  （默认 100）官方每日调用上限，付费后调大
 *   UPSTREAM   （默认官方地址）
 *   WARM       （默认 off）设为 on 时后台预热"进行中比赛"
 *   WARM_MS    （默认 30000）预热间隔
 *   LEAGUE_ID / SEASON （默认 1 / 2026）
 */
'use strict';
const http = require('http');
const { URL } = require('url');

const API_KEY   = process.env.API_KEY || '';
const UPSTREAM   = process.env.UPSTREAM || 'https://v3.football.api-sports.io';
const PORT       = parseInt(process.env.PORT || '8787', 10);
const DAILY_CAP  = parseInt(process.env.DAILY_CAP || '100', 10);
const LEAGUE_ID  = process.env.LEAGUE_ID || '1';
const SEASON     = process.env.SEASON || '2026';
const WARM       = (process.env.WARM || 'off') === 'on';
const WARM_MS    = parseInt(process.env.WARM_MS || '30000', 10);

if (!API_KEY) console.warn('⚠ 未设置环境变量 API_KEY，将无法调用官方 API');

/* ---------- 可选：托管网页本体（同目录有 html 文件就一并提供）---------- */
const fs = require('fs');
let PAGE = null, PAGE_NAME = null;
for (const f of ['index.html', 'worldcup_predict_live.html', 'app.html']) {
  try { const fp = __dirname + '/' + f; if (fs.existsSync(fp)) { PAGE = fs.readFileSync(fp); PAGE_NAME = f; break; } } catch (e) {}
}

/* ---------- 缓存 ---------- */
const cache = new Map();               // path -> { data:<string>, exp:<ms> }
function ttlFor(path) {
  if (path.includes('/teams/statistics'))   return 12 * 3600e3; // 队伍数据：半天
  if (path.includes('/players'))            return 12 * 3600e3; // 球员资料：半天
  if (path.includes('/injuries'))           return 3600e3;      // 伤停：1 小时
  if (path.includes('/fixtures/lineups'))   return 5 * 60e3;    // 首发：5 分钟
  if (/fixtures\?team=.*last=/.test(path))  return 6 * 3600e3;  // 某队近 N 场：6 小时
  if (path.includes('/fixtures/statistics'))return 20e3;        // 技术统计：20 秒
  if (path.includes('live=all'))            return 15e3;        // 进行中列表：15 秒
  if (path.includes('next='))               return 30 * 60e3;   // 赛程：30 分钟
  if (/fixtures\?id=/.test(path))           return 15e3;        // 单场实时：15 秒
  return 15e3;
}

/* ---------- 官方用量计数（按 UTC 日重置）---------- */
const today = () => new Date().toISOString().slice(0, 10);
let usage = { day: today(), count: 0 };
function rollover() { if (usage.day !== today()) usage = { day: today(), count: 0 }; }

/* ---------- 并发去重 + 取数 ---------- */
const inflight = new Map();            // path -> Promise<string>

async function fetchUpstream(path) {
  rollover();
  if (usage.count >= DAILY_CAP) { const e = new Error('DAILY_CAP_REACHED'); e.quota = true; throw e; }
  const r = await fetch(UPSTREAM + path, { headers: { 'x-apisports-key': API_KEY } });
  usage.count++;                       // 计一次官方调用
  const text = await r.text();
  if (!r.ok) { const e = new Error('upstream ' + r.status); e.status = r.status; throw e; }
  return text;
}

function getData(path) {
  const hit = cache.get(path);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.data);  // 命中缓存：不调官方
  if (inflight.has(path)) return inflight.get(path);                  // 同 path 已在拉：复用
  const p = (async () => {
    try {
      const text = await fetchUpstream(path);
      cache.set(path, { data: text, exp: Date.now() + ttlFor(path) });
      return text;
    } catch (e) {
      if (hit) return hit.data;        // 额度用尽 / 出错：回退过期缓存
      throw e;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

/* ---------- HTTP 服务 ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
const ALLOW = /^\/(fixtures|teams|players|injuries|standings|leagues|coachs|transfers|trophies|sidelined|venues|status)\b/;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const u = new URL(req.url, 'http://localhost');

  // 托管网页：访问根路径直接打开 App
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/app')) {
    if (PAGE) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;line-height:1.8">数据代理服务器运行中 ✅<br>把网页文件（worldcup_predict_live.html 或 index.html）放到本服务同一个仓库，重新部署即可在此直接打开 App。<br>查看官方用量：<a href="/admin/status">/admin/status</a></body>');
  }

  if (u.pathname === '/healthz') { res.writeHead(200, CORS); return res.end('ok'); }

  if (u.pathname === '/admin/status') {        // 监控官方用量
    rollover();
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({
      day: usage.day, used: usage.count, cap: DAILY_CAP,
      left: Math.max(0, DAILY_CAP - usage.count), cached: cache.size
    }));
  }

  if (!ALLOW.test(u.pathname)) { res.writeHead(404, CORS); return res.end(JSON.stringify({ error: 'not found', response: [] })); }

  try {
    const data = await getData(u.pathname + (u.search || ''));
    res.writeHead(200, CORS);
    res.end(data);
  } catch (e) {
    res.writeHead(e.quota ? 429 : 502, CORS);
    res.end(JSON.stringify({ error: String(e.message), response: [] }));
  }
});

/* ---------- 可选：后台预热进行中比赛（默认关闭，避免空耗额度）---------- */
if (WARM) {
  setInterval(() => {
    getData(`/fixtures?live=all&league=${LEAGUE_ID}&season=${SEASON}`).catch(() => {});
  }, WARM_MS);
}

server.listen(PORT, () => {
  console.log(`代理服务器已启动 http://localhost:${PORT}  官方每日上限=${DAILY_CAP}  预热=${WARM ? 'on' : 'off'}`);
  console.log('网页托管: ' + (PAGE ? ('开启 (' + PAGE_NAME + ')') : '未找到页面文件，仅作数据代理'));
});

module.exports = server;   // 便于自动化测试引用
