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
const DAILY_CAP  = parseInt(process.env.DAILY_CAP || '75000', 10);  // 付费档默认上限（可用环境变量覆盖）
const LEAGUE_ID  = process.env.LEAGUE_ID || '1';
const SEASON     = process.env.SEASON || '2026';
const WARM       = (process.env.WARM || 'off') === 'on';
const WARM_MS    = parseInt(process.env.WARM_MS || '30000', 10);

/* ---------- AI 助手（火山方舟·豆包）---------- */
const ARK_API_KEY  = process.env.ARK_API_KEY || '';
const ARK_MODEL    = process.env.ARK_MODEL || 'doubao-seed-2-0-lite-260428';
const ARK_BASE     = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const AI_DAILY_CAP = parseInt(process.env.AI_DAILY_CAP || '8000', 10);   // AI 每日调用上限
const AI_MAX_TOKENS= parseInt(process.env.AI_MAX_TOKENS || '800', 10);   // 单条回复 token 上限
const AI_HOURLY    = parseInt(process.env.AI_HOURLY_PER_IP || '150', 10);// 每 IP 每小时上限
const AI_MAX_UNITS = parseInt(process.env.AI_MAX_UNITS || '300', 10);    // 单条输入上限（中文字/英文单词混合，英文单词计 1，含标点）
function countUnits(s){ const m = String(s || '').match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]|[A-Za-z0-9]+(?:['\u2019\-_][A-Za-z0-9]+)*|[^\s]/g); return m ? m.length : 0; }
const AI_SYSTEM = [
  '你是「2026世界杯胜率预测」网页里的 AI 助手豆包，一个纯文字大语言模型。定位是世界杯/足球答疑助手。',
  '【可以充分发挥】对足球相关的问题——2026世界杯、赛制规则、足球术语（xG、越位、点球、各类预测模型等）、参赛球队、球员、教练、战术打法、足球历史、转会、以及足彩（如何看赔率/让球/亚盘/大小球、如何做赛事分析）——请正常发挥你的知识与分析能力，答得专业、有条理、有干货，不必刻意简短。',
  '【足彩底线】涉及足彩时可以讲知识与分析方法，但务必保持理性：提醒"投注有风险、量力而行"，绝不承诺"稳赢/包中/必中"，不诱导加注。',
  '【尊重本站事实，不要编造】关于"本网页有什么功能"，只能依据事实回答，不得虚构不存在的栏目/入口/数据。本网页实际包含：① 赛程；② 实况（进行中比分与胜率、24小时内开赛倒计时）；③ 球队（含球队详情、球员档案）；④ 积分（小组排名、出线形势、最佳第三名、射手榜、本站模型推算的出线概率）；⑤ 赛前对阵预测（融合双方实力近况、伤停、首发，临场还会结合市场赔率）；⑥ 问豆包（即你）。本站胜率预测用的是基于泊松分布的进球模型，叠加 FIFA 实力先验、对手强弱加权的近况、以及市场赔率，并非严格的 Dixon-Coles 模型。涉及实时比分/赛程/阵容/积分时，提示用户到对应页面查看，不要凭空描述具体数值。',
  '【能力边界】你只能进行文字问答：不能生成图片/视频/音频，不能上传、读取或分析文件与截图。被要求这类功能时如实说明，不要提供替代的生成/绘图方案。不要编造不存在的链接或资源；不确定就直说。',
  '【无关话题】与足球/世界杯完全无关的请求（如写代码、写作业、闲聊其它领域），礼貌说明你主要负责世界杯与足球答疑，引导回相关话题，不展开作答。',
  '用简体中文、口语自然。简单问题简洁回答；需要展开的足球问题可以详细些，但避免无意义的长篇。'
].join('\n');

if (!API_KEY) console.warn('⚠ 未设置环境变量 API_KEY，将无法调用官方 API');

/* ---------- 可选：托管网页本体（同目录有 html 文件就一并提供）---------- */
const fs = require('fs');
/* ---------- 预测存档（持久磁盘）---------- */
const DATA_DIR = process.env.DATA_DIR || '/var/data';      // Render 持久磁盘挂载路径（可用环境变量覆盖）
const ARCHIVE_PATH = DATA_DIR + '/predictions.json';
function readArchive() {
  try { if (fs.existsSync(ARCHIVE_PATH)) return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8') || '{}'); } catch (e) {}
  try { const seed = __dirname + '/predictions.json'; if (fs.existsSync(seed)) return JSON.parse(fs.readFileSync(seed, 'utf8') || '{}'); } catch (e) {}  // 磁盘无 → 用仓库种子
  return {};
}
function writeArchive(obj) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(obj)); return true; }
  catch (e) { console.warn('写预测存档失败:', e.message); return false; }
}
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
let aiUsage = { day: today(), count: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
function aiRollover() { if (aiUsage.day !== today()) aiUsage = { day: today(), count: 0, tokens: { prompt: 0, completion: 0, total: 0 } }; }

// 在线人数探测：客户端定时心跳，统计最近 PRESENCE_TTL 内活跃的访客
const presence = new Map();                 // id -> 最近活跃时间(ms)
const PRESENCE_TTL = 45000;
function presenceTouch(id) {
  const now = Date.now();
  if (id) presence.set(String(id).slice(0, 64), now);
  for (const [k, t] of presence) { if (now - t > PRESENCE_TTL) presence.delete(k); }
  return presence.size;
}
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
const ALLOW = /^\/(fixtures|teams|players|injuries|standings|leagues|coachs|transfers|trophies|sidelined|venues|status|odds)\b/;

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

  if (u.pathname === '/presence') {            // 在线人数心跳：注册并返回当前在线数
    const online = presenceTouch((u.searchParams && u.searchParams.get('id')) || '');
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({ online }));
  }

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

  // 预测存档：赛前锁定的预测（用于"预测战绩/准确率"页）。从持久磁盘读取，无则回退仓库种子/空对象
  if (req.method === 'GET' && u.pathname === '/predictions.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(readArchive()));
  }

  // 锁定赛前预测：首发齐后由前端上报，先到先得(write-once) + 校验该场仍"未开赛"，杜绝赛后补写
  if (u.pathname === '/predict/lock') {
    if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ ok: false, err: 'method' })); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const d = JSON.parse(body || '{}');
        const fid = String(d.fixtureId == null ? '' : d.fixtureId).replace(/[^0-9]/g, '');
        if (!fid || !d.o || !d.s) { res.writeHead(400, CORS); return res.end(JSON.stringify({ ok: false, err: 'bad_input' })); }
        const arch = readArchive();
        if (arch[fid]) { res.writeHead(200, CORS); return res.end(JSON.stringify({ ok: true, already: true })); }  // 已锁定，先到先得
        let ns = false;
        try { const j = JSON.parse(await getData('/fixtures?id=' + fid)); const st = j && j.response && j.response[0] && j.response[0].fixture && j.response[0].fixture.status && j.response[0].fixture.status.short; ns = (st === 'NS'); } catch (e) {}
        if (!ns) { res.writeHead(409, CORS); return res.end(JSON.stringify({ ok: false, err: 'not_ns' })); }  // 已开赛/查不到 → 不接受
        arch[fid] = { o: d.o, s: d.s, h: d.h || '', a: d.a || '', probs: d.probs || null, scores: d.scores || null, at: Date.now() };
        const okw = writeArchive(arch);
        res.writeHead(okw ? 200 : 500, CORS); return res.end(JSON.stringify({ ok: okw }));
      } catch (e) { res.writeHead(500, CORS); return res.end(JSON.stringify({ ok: false, err: 'server' })); }
    });
    return;
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
                 .slice(-8).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
      if (!msgs.length) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: '消息为空' })); }
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      if (lastUser && countUnits(lastUser.content) > AI_MAX_UNITS) {
        res.writeHead(200, CORS);
        return res.end(JSON.stringify({ error: '问题太长啦，请精简到 ' + AI_MAX_UNITS + ' 字以内（中英文合计，英文单词按 1 计）。' }));
      }
      const payload = { model: ARK_MODEL, messages: [{ role: 'system', content: AI_SYSTEM }, ...msgs], max_tokens: AI_MAX_TOKENS, temperature: 0.7, stream: true, stream_options: { include_usage: true } };
      const r = await fetch(ARK_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ARK_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok || !r.body) { res.writeHead(200, CORS); return res.end(JSON.stringify({ error: 'AI 服务暂时不可用（' + r.status + '），请稍后再试' })); }
      aiUsage.count++;
      // 以 SSE 把豆包的流式增量转发给前端
      res.writeHead(200, Object.assign({}, CORS, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }));
      const reader = r.body.getReader(); const dec = new TextDecoder(); let sbuf = '', any = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sbuf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = sbuf.indexOf('\n')) >= 0) {
            const line = sbuf.slice(0, nl).trim(); sbuf = sbuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) { any = true; res.write('data: ' + JSON.stringify({ t: delta }) + '\n\n'); }
              if (j.usage) {   // 流式末尾的用量块（include_usage）
                aiUsage.tokens.prompt += j.usage.prompt_tokens || 0;
                aiUsage.tokens.completion += j.usage.completion_tokens || 0;
                aiUsage.tokens.total += j.usage.total_tokens || ((j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0));
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
      if (!any) res.write('data: ' + JSON.stringify({ t: '（这次没有返回内容，换个问法再试试～）' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (e) {
      try { res.writeHead(200, CORS); } catch (_) {}
      return res.end(JSON.stringify({ error: 'AI 请求失败，请稍后重试' }));
    }
  }

  if (u.pathname === '/admin/status') {        // 监控官方用量
    rollover(); aiRollover();
    res.writeHead(200, CORS);
    return res.end(JSON.stringify({
      day: usage.day, used: usage.count, cap: DAILY_CAP,
      left: Math.max(0, DAILY_CAP - usage.count), cached: cache.size,
      online: presenceTouch(''),
      ai: { used: aiUsage.count, cap: AI_DAILY_CAP, left: Math.max(0, AI_DAILY_CAP - aiUsage.count), configured: !!ARK_API_KEY, tokens: aiUsage.tokens }
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
