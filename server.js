const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// ดึงค่าความลับจาก Environment Variables บน Render เท่านั้น (ไม่แสดงใน GitHub)
const GAS_URL = process.env.GAS_URL;
const APP_PASSWORD = process.env.APP_PASSWORD;

// สำหรับ Cron-job.org เรียกปลุกเซิร์ฟเวอร์
app.get('/ping', (req, res) => res.status(200).send('Awake'));

// ตรวจสอบรหัสผ่าน (รองรับทั้ง Header และ Query สำหรับ Stream Proxy)
function requireAuth(req, res, next) {
  const pass = req.headers['x-app-password'] || req.query.pass;
  if (!APP_PASSWORD || pass !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 1. ตรวจสอบรหัสผ่านตอนเข้าเว็บ
app.post('/api/auth', (req, res) => {
  if (APP_PASSWORD && req.body.password === APP_PASSWORD) {
    return res.json({ status: 'ok' });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// 2. Proxy ซ่อน Google Apps Script (ดึง Playlist)
app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const response = await fetch(GAS_URL);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Proxy ซ่อน Google Apps Script (บันทึก/แก้ไข Playlist)
app.post('/api/playlists', requireAuth, async (req, res) => {
  try {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. ค้นหาวิดีโอสูงสุดทั้งหมด
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const r = await yts(query);
    const videos = r.videos.map(v => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author.name,
      duration: v.timestamp,
      seconds: v.seconds,
      thumbnail: v.thumbnail
    }));

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ระบบสกัด Direct MP4 Stream หลายช่องทาง (ไร้โฆษณา 100%)
const COBALT_NODES = [
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.api.timelessnesses.me'
];

const PIPED_NODES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.projectsegfau.lt'
];

const INVIDIOUS_NODES = [
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://yewtu.be'
];

app.get('/api/stream', requireAuth, async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // ชั้นที่ 1: Cobalt API (เสถียรและไม่ติดบล็อกโฆษณา)
  for (const node of COBALT_NODES) {
    try {
      const r = await fetch(`${node}/`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: ytUrl, vQuality: '720' }),
        signal: AbortSignal.timeout(4000)
      });
      if (r.ok) {
        const data = await r.json();
        if (data.url) {
          return res.json({ url: data.url, source: 'cobalt-direct' });
        }
      }
    } catch (e) {}
  }

  // ชั้นที่ 2: Invidious API
  for (const node of INVIDIOUS_NODES) {
    try {
      const r = await fetch(`${node}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(3500)
      });
      if (r.ok) {
        const data = await r.json();
        const fmt = (data.formatStreams || []).find(f => f.container === 'mp4');
        if (fmt && fmt.url) {
          return res.json({ url: fmt.url, source: 'invidious-direct', proxyNode: node });
        }
      }
    } catch (e) {}
  }

  // ชั้นที่ 3: Piped API
  for (const node of PIPED_NODES) {
    try {
      const r = await fetch(`${node}/streams/${videoId}`, {
        signal: AbortSignal.timeout(3500)
      });
      if (r.ok) {
        const data = await r.json();
        const stream = (data.videoStreams || []).find(s => !s.videoOnly && s.format === 'MPEG_4');
        if (stream && stream.url) {
          return res.json({ url: stream.url, source: 'piped-direct' });
        }
      }
    } catch (e) {}
  }

  res.status(404).json({ error: 'No direct stream available' });
});

// 6. ท่อส่งวิดีโอตรง (Stream Proxy) แก้ปัญหาลิงก์ MP4 ติดบล็อก IP/CORS บนเบราว์เซอร์
app.get('/api/proxy-stream', requireAuth, async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).end();

  try {
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

    const response = await fetch(targetUrl, { headers });
    res.status(response.status);

    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.status(500).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
