const express = require('express');

const cors = require('cors');

const fs = require('fs');

const path = require('path');


const app = express();

app.use(express.static(__dirname));

// 手动强行放行跨域请求
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());

// 允许前端跨域请求和解析 JSON
app.use(express.json());
app.use(express.static(__dirname)); // 让网页能直接访问

const DATA_FILE = path.join(__dirname, 'data.json');

// 接口 1：保存玩家数据
app.post('/api/save', (req, res) => {
    const { name, balance, debt } = req.body;
    if (!name) return res.status(400).send('Missing name');

    let data = {};
    if (fs.existsSync(DATA_FILE)) {
        try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    }

    // 更新或写入该玩家的数据
    data[name] = { balance, debt, updatedAt: Date.now() };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    
    res.json({ success: true });
});

// 接口 2：获取所有玩家排行榜
app.get('/api/rank', (req, res) => {
    let data = {};
    if (fs.existsSync(DATA_FILE)) {
        try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    }

    // 转换成数组并按净值（余额 - 债务）排序
    const rankList = Object.keys(data).map(name => {
        const p = data[name];
        const net = p.balance - p.debt;
        return { name, net };
    }).sort((a, b) => b.net - a.net).slice(0, 10); // 取前10名

    res.json(rankList);
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});




// 数据文件路径

const DB_FILE = path.join(__dirname, 'data.json');



// 初始化数据库

if (!fs.existsSync(DB_FILE)) {

  fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));

}



// 读取数据

function readDB() {

  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

}



// 写入数据

function writeDB(data) {

  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

}



// 路由 1：获取或注册玩家数据

app.post('/api/login', (req, res) => {

  const { username } = req.body;

  let db = readDB();

  

  if (!db.users[username]) {

    db.users[username] = {

      balance: 10000,

      debt: 0,

      positions: [],

      tradesCount: 0,

      winTrades: 0

    };

    writeDB(db);

  }

  res.json(db.users[username]);

});



// 路由 2：处理交易（开仓/平仓等）

app.post('/api/trade', (req, res) => {

  const { username, action, margin, leverage } = req.body;

  let db = readDB();

  let user = db.users[username];



  if (!user) return res.status(404).json({ error: '用户不存在' });



  // 这里可以写具体的开仓、平仓逻辑

  // 为了演示，我们假设每次调用直接扣除保证金

  if (action === 'open_long' || action === 'open_short') {

    if (user.balance < margin) return res.status(400).json({ error: '余额不足' });

    user.balance -= margin;

    user.positions.push({ action, margin, leverage, entryRate: 1.10000 }); // 实际上这里应该传当前汇率

    user.tradesCount++;

    writeDB(db);

    return res.json({ success: true, message: '开仓成功', user });

  }



  res.json({ success: true, user });

});

app.get('/api/leaderboard', (req, res) => {
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let list = [];
    for (let name in db.users) {
        list.push({ name: name, netWorth: db.users[name].balance - db.users[name].debt });
    }
    list.sort((a, b) => b.netWorth - a.netWorth);
    res.json(list.slice(0, 5));
});

// 路由 4：还款接口
app.post('/api/repay', (req, res) => {
    const { username } = req.body;
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let user = db.users[username];

    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.debt <= 0) return res.status(400).json({ error: '当前没有欠款' });
    if (user.balance < user.debt) return res.status(400).json({ error: '可用资金不足，无法还清' });

    // 扣除余额，清空债务
    user.balance -= user.debt;
    const repaidAmount = user.debt;
    user.debt = 0;

    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    res.json({ success: true, user, repaidAmount });
});

app.post('/api/reset', (req, res) => {
    const { username } = req.body;
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let user = db.users[username];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    
    user.balance = 10000; // 重置为 10000
    user.debt = 0;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    res.json({ success: true, user });
});

// 启动服务器

app.listen(4000, () => {

  console.log('✅ FX 后端服务器已启动: http://127.0.0.1:4000');

});



