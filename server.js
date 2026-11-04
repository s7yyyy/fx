/**
 * FX 简单! 后端（Express）
 *
 * 相对你原来那版的变化：
 *   1. 只监听 4000（原来还多监听了一个 3000，会和 SnowLuma 的 OneBot HTTP 端口撞车）
 *   2. 数据统一存进 data.json 的 users 里；老文件里散在顶层的玩家会自动迁移进来，不丢
 *   3. /api/rank 只从 users 取，不再把 "users" 本身当成一名玩家（原来会算出 NaN）
 *   4. 新增 GET /api/tunnel：从 cpolar 的 -log 文件读当前公网地址
 *   5. 落盘改成「延迟 300ms + 先写 .tmp 再改名」，页面每秒上报也不会把磁盘写爆
 *   6. 昵称清洗（去标签、限长），页面是 innerHTML 直插的
 *
 * 启动：node server.js
 * 环境变量：PORT=4000  CPOLAR_LOG=<cpolar日志路径>
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const DATA_FILE = path.join(__dirname, 'data.json');
const CPOLAR_LOG = process.env.CPOLAR_LOG
  || path.join(process.env.USERPROFILE || os.homedir(), '.cpolar', 'cpolar.log');

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── 数据层 ────────────────────────────────────────────────────────────
let db = { users: {} };
let writeTimer = null;
let dirty = false;

function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function freshUser() {
  return { balance: 10000, debt: 0, positions: [], tradesCount: 0, winTrades: 0 };
}

function ensureUser(name) {
  if (!db.users[name]) db.users[name] = freshUser();
  return db.users[name];
}

function loadDB() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('没有 data.json，新建一个');
      db = { users: {} };
      return;
    }
    const bad = `${DATA_FILE}.bad-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bad); } catch {}
    log(`⚠️ data.json 读不出来（${error.message}），已备份到 ${path.basename(bad)}，从空表开始`);
    db = { users: {} };
    return;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const bad = `${DATA_FILE}.bad-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bad); } catch {}
    log('⚠️ data.json 顶层不是对象，已备份并从空表开始');
    db = { users: {} };
    return;
  }

  db = raw;
  if (!db.users || typeof db.users !== 'object') db.users = {};

  // 迁移：老版本 /api/save 会把玩家写到顶层，这里把它们并进 users
  let migrated = 0;
  for (const key of Object.keys(db)) {
    if (key === 'users') continue;
    const value = db[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof value.balance !== 'number' && typeof value.debt !== 'number') continue;
    const name = sanitizeName(value.name || key);
    if (!name) continue;
    if (!db.users[name]) {
      db.users[name] = { ...freshUser(), ...value, name };
      migrated++;
    }
    delete db[key];
  }
  for (const [name, user] of Object.entries(db.users)) {
    db.users[name] = { ...freshUser(), ...(user || {}), name };
  }
  log(`已载入 ${Object.keys(db.users).length} 位玩家${migrated ? `（迁移了 ${migrated} 位老数据）` : ''}`);
  if (migrated) scheduleSave();
}

function writeNow() {
  if (!dirty) return;
  dirty = false;
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (error) {
    dirty = true;
    log(`⚠️ 写 data.json 失败：${error.message}`);
  }
}

function scheduleSave() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, 300);
}

// ── 接口 ──────────────────────────────────────────────────────────────
app.post('/api/save', (req, res) => {
  const name = sanitizeName(req.body?.name);
  const balance = Number(req.body?.balance);
  const debt = Number(req.body?.debt);
  if (!name) return res.status(400).json({ success: false, error: 'Missing name' });
  if (!Number.isFinite(balance) || !Number.isFinite(debt)) {
    return res.status(400).json({ success: false, error: 'bad numbers' });
  }
  const user = ensureUser(name);
  user.balance = Math.round(balance * 100) / 100;
  user.debt = Math.round(debt * 100) / 100;
  user.updatedAt = Date.now();
  scheduleSave();
  res.json({ success: true });
});

// ── 排行榜过滤：把自动生成的空号挡在外面 ────────────────────────
const AUTO_NAME = /^(?:玩家|手机玩家|匿名交易员|无名氏|Guest|guest)(?:[_\-]?\d+)?$/;
const SHOW_EMPTY = process.env.RANK_SHOW_EMPTY === '1';

function isRankable(name, user) {
  if (SHOW_EMPTY) return true;
  const trades = Number(user.tradesCount) || 0;
  const net = (Number(user.balance) || 0) - (Number(user.debt) || 0);
  if (trades === 0 && Math.abs(net - 10000) < 0.01) return false;
  if (trades === 0 && AUTO_NAME.test(name)) return false;
  return true;
}

app.get('/api/rank', (req, res) => {
  const list = Object.entries(db.users)
    .filter(([name, user]) => isRankable(name, user))
    .map(([name, user]) => ({
      name,
      net: Math.round(((Number(user.balance) || 0) - (Number(user.debt) || 0)) * 100) / 100,
    }))
    .sort((a, b) => b.net - a.net)
    .slice(0, 50);
  res.json(list);
});

app.get('/api/leaderboard', (req, res) => {
  const list = Object.entries(db.users)
    .filter(([name, user]) => isRankable(name, user))
    .map(([name, user]) => ({
      name,
      netWorth: Math.round(((Number(user.balance) || 0) - (Number(user.debt) || 0)) * 100) / 100,
    }))
    .sort((a, b) => b.netWorth - a.netWorth)
    .slice(0, 50);
  res.json(list);
});

app.post('/api/login', (req, res) => {
  const name = sanitizeName(req.body?.username);
  if (!name) return res.status(400).json({ error: '缺少用户名' });
  const user = ensureUser(name);
  scheduleSave();
  res.json(user);
});

app.post('/api/trade', (req, res) => {
  const name = sanitizeName(req.body?.username);
  const { action, margin, leverage } = req.body ?? {};
  const user = db.users[name];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (action === 'open_long' || action === 'open_short') {
    const amount = Number(margin) || 0;
    if (user.balance < amount) return res.status(400).json({ error: '余额不足' });
    user.balance -= amount;
    user.positions.push({
      action,
      margin: amount,
      leverage: Number(leverage) || 1,
      entryRate: Number(req.body?.entryRate) || 1.1,
    });
    user.tradesCount++;
    scheduleSave();
    return res.json({ success: true, message: '开仓成功', user });
  }
  res.json({ success: true, user });
});

app.post('/api/repay', (req, res) => {
  const name = sanitizeName(req.body?.username);
  const user = db.users[name];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.debt <= 0) return res.status(400).json({ error: '当前没有欠款' });
  if (user.balance < user.debt) return res.status(400).json({ error: '可用资金不足，无法还清' });
  user.balance -= user.debt;
  const repaidAmount = user.debt;
  user.debt = 0;
  scheduleSave();
  res.json({ success: true, user, repaidAmount });
});

app.post('/api/reset', (req, res) => {
  const name = sanitizeName(req.body?.username);
  const user = db.users[name];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  user.balance = 10000;
  user.debt = 0;
  user.positions = [];
  user.tradesCount = 0;
  user.winTrades = 0;
  scheduleSave();
  res.json({ success: true, user });
});

// ── 当前隧道地址（读 cpolar 的 -log 文件）────────────────────────────
let tunnelCache = { at: 0, url: null, source: null };

app.get('/api/tunnel', (req, res) => {
  if (Date.now() - tunnelCache.at < 5000) return res.json(tunnelCache);
  let text = '';
  try {
    const stat = fs.statSync(CPOLAR_LOG);
    const start = Math.max(0, stat.size - 256 * 1024);
    const fd = fs.openSync(CPOLAR_LOG, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const matches = text.match(/https:\/\/[a-z0-9.-]+\.cpolar\.(?:cn|top|cc)/gi);
    tunnelCache = { at: Date.now(), url: matches ? matches[matches.length - 1].toLowerCase() : null, source: CPOLAR_LOG };
  } catch (error) {
    tunnelCache = { at: Date.now(), url: null, source: `读不到 ${CPOLAR_LOG}（${error.code || error.message}）` };
  }
  res.json(tunnelCache);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, players: Object.keys(db.users).length, uptime: Math.round(process.uptime()) });
});

loadDB();

const server = app.listen(PORT, '0.0.0.0', () => {
  log(`✅ FX 后端已启动：http://127.0.0.1:${PORT}/`);
  log(`数据文件：${DATA_FILE}`);
  log(`cpolar 日志：${CPOLAR_LOG}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('退出前保存数据…');
    writeNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
