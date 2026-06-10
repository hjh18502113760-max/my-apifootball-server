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
const DAILY_CAP  = parseInt(process.env.DAILY_CAP || '70000', 10);  // 付费档默认上限（可用环境变量覆盖）
const LEAGUE_ID  = process.env.LEAGUE_ID || '1';
const SEASON     = process.env.SEASON || '2026';
const WARM       = (process.env.WARM || 'off') === 'on';
const WARM_MS    = parseInt(process.env.WARM_MS || '30000', 10);

/* ---------- AI 助手（火山方舟·豆包）---------- */
const ARK_API_KEY  = process.env.ARK_API_KEY || '';
const ARK_MODEL    = process.env.ARK_MODEL || 'doubao-seed-2-0-lite-260428';
const ARK_BASE     = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const AI_DAILY_CAP = parseInt(process.env.AI_DAILY_CAP || '2000', 10);   // AI 每日调用上限
const AI_MAX_TOKENS= parseInt(process.env.AI_MAX_TOKENS || '500', 10);   // 单条回复 token 上限
const AI_HOURLY    = parseInt(process.env.AI_HOURLY_PER_IP || '150', 10);// 每 IP 每小时上限
const AI_SYSTEM = '你是「世界杯胜率预测」App 内的 AI 助手（基于豆包）。用简体中文、简洁口语化地回答用户关于 2026 世界杯、足球规则与术语（如 xG、越位、点球、Dixon-Coles 模型）、赛制、参赛球队等问题。回答尽量控制在 5 句话内，必要时用简短分点。不要编造确定的比分或结果；遇到“实时比分/具体赛程/某队最新阵容”这类问题，可简要回答并提示用户查看 App 内对应页面（实况 / 赛程 / 球队）。';

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
  if (path.includes('/fixtures/events'))    return 24 * 3600e3; // 已结束比赛进球事件：1 天
  if (/teams\?league=/.test(path))          return 24 * 3600e3; // 参赛球队列表：1 天
  if (path.includes('/players'))            return 12 * 3600e3; // 球员资料：半天
  if (path.includes('/injuries'))           return 3600e3;      // 伤停：1 小时
  if (path.includes('/fixtures/lineups'))   return 5 * 60e3;    // 首发：5 分钟
  if (/fixtures\?team=.*last=/.test(path))  return 6 * 3600e3;  // 某队近 N 场：6 小时
  if (/fixtures\?team=/.test(path))         return 30 * 60e3;   // 某队全部赛事：30 分钟
  if (path.includes('/fixtures/statistics'))return 20e3;        // 技术统计：20 秒
  if (path.includes('live=all'))            return 15e3;        // 进行中列表：15 秒
  if (path.includes('next='))               return 30 * 60e3;   // 赛程：30 分钟
  if (/fixtures\?league=/.test(path))       return 30 * 60e3;   // 全量赛程：30 分钟
  if (/fixtures\?id=/.test(path))           return 15e3;        // 单场实时：15 秒
  return 15e3;
}

/* ---------- 官方用量计数（按 UTC 日重置）---------- */
const today = () => new Date().toISOString().slice(0, 10);
let usage = { day: today(), count: 0 };
function rollover() { if (usage.day !== today()) usage = { day: today(), count: 0 }; }

/* ---------- AI 用量：每日总量 + 每 IP 每小时限流 ---------- */
let aiUsage = { day: today(), count: 0 };
function aiRollover() { if (aiUsage.day !== today()) aiUsage = { day: today(), count: 0 }; }
const aiIpHits = new Map();              // ip -> { hour, count }
function aiIpAllowed(ip) {
  const h = Math.floor(Date.now() / 3600e3);
  if (aiIpHits.size > 5000) { for (const [k, v] of aiIpHits) if (v.hour !== h) aiIpHits.delete(k); }
  let rec = aiIpHits.get(ip);
  if (!rec || rec.hour !== h) { rec = { hour: h, count: 0 }; aiIpHits.set(ip, rec); }
  if (rec.count >= AI_HOURLY) return false;
  rec.count++; return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', c => { size += c.length; if (size > 100000) { reject(new Error('body too large')); req.destroy(); } else data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
const ALLOW = /^\/(fixtures|teams|players|injuries|standings|leagues|coachs|transfers|trophies|sidelined|venues|status)\b/;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const u = new URL(req.url, 'http://localhost');

  // 托管网页：访问根路径直接打开 App
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/app')) {
    if (PAGE) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' }); return res.end(PAGE); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;line-height:1.8">数据代理服务器运行中 ✅<br>把网页文件（worldcup_predict_live.html 或 index.html）放到本服务同一个仓库，重新部署即可在此直接打开 App。<br>查看官方用量：<a href="/admin/status">/admin/status</a></body>');
  }

  if (u.pathname === '/healthz') { res.writeHead(200, CORS); return res.end('ok'); }

  // PWA manifest（让"添加到主屏幕"用上图标/名称/独立全屏）
  if (u.pathname === '/manifest.webmanifest' || u.pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      name: '世界杯胜率预测', short_name: '胜率预测', start_url: '/', scope: '/',
      display: 'standalone', orientation: 'portrait',
      background_color: '#070a11', theme_color: '#0b111c',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    }));
  }

  // 静态图标：同目录下的 .png 直接提供
  if (req.method === 'GET' && /^\/[\w.\-]+\.png$/.test(u.pathname)) {
    try {
      const fp = __dirname + u.pathname;
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
        return res.end(fs.readFileSync(fp));
      }
    } catch (e) {}
  }

  // AI 助手：把对话转发给火山方舟·豆包（API key 仅存于服务器端）
  if (u.pathname === '/ai/chat') {
    if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'method not allowed' })); }
    if (!ARK_API_KEY) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: 'AI 暂未配置（服务器缺少 ARK_API_KEY）' })); }
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
    aiRollover();
    if (aiUsage.count >= AI_DAILY_CAP) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: '今日 AI 提问额度已用完，明天再来聊吧～' })); }
    if (!aiIpAllowed(ip)) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: '提问有点频繁，歇一会儿再问吧（已达每小时上限）。' })); }
    try {
      const raw = await readBody(req);
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
      let msgs = Array.isArray(body.messages) ? body.messages : [];
      msgs = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                 .slice(-8).map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
      if (!msgs.length) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: '消息为空' })); }
      const payload = { model: ARK_MODEL, messages: [{ role: 'system', content: AI_SYSTEM }, ...msgs], max_tokens: AI_MAX_TOKENS, temperature: 0.7 };
      const r = await fetch(ARK_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ARK_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const txt = await r.text();
      if (!r.ok) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: 'AI 服务暂时不可用（' + r.status + '），请稍后再试' })); }
      aiUsage.count++;
      let reply = '';
      try { const j = JSON.parse(txt); reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; } catch (_) {}
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ reply: reply || '（这次没有返回内容，换个问法再试试～）' }));
    } catch (e) {
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ error: 'AI 请求失败，请稍后重试' }));
    }
  }

  if (u.pathname === '/admin/status') {        // 监控官方用量
    rollover(); aiRollover();
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({
      day: usage.day, used: usage.count, cap: DAILY_CAP,
      left: Math.max(0, DAILY_CAP - usage.count), cached: cache.size,
      ai: { used: aiUsage.count, cap: AI_DAILY_CAP, left: Math.max(0, AI_DAILY_CAP - aiUsage.count), configured: !!ARK_API_KEY }
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
  console.log('AI 助手(豆包): ' + (ARK_API_KEY ? ('已配置 · 模型=' + ARK_MODEL + ' · 每日上限=' + AI_DAILY_CAP) : '未配置(设置 ARK_API_KEY 后启用)'));
});

module.exports = server;   // 便于自动化测试引用
