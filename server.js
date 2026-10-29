const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');

const app = express();
app.use(cors());
app.use(express.json());

// ดึงค่าความลับจาก Environment Variables บน Render (ปลอดภัย 100%)
const GAS_URL = process.env.GAS_URL;
const APP_PASSWORD = process.env.APP_PASSWORD || '1234';

// ปลุกเซิร์ฟเวอร์สำหรับ Cron-job.org
app.get('/ping', (req, res) => res.status(200).send('Awake'));

// Middleware ตรวจสอบรหัสผ่านทุกครั้งที่เรียก API
function requireAuth(req, res, next) {
  const pass = req.headers['x-app-password'];
  if (pass !== APP_PASSWORD) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  next();
}

// 1. ตรวจสอบรหัสผ่านตอนเข้าเว็บ
app.post('/api/auth', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    return res.json({ status: 'ok' });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// 2. Proxy ซ่อน Google Apps Script (ดึงข้อมูล Playlist)
app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const response = await fetch(GAS_URL);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Proxy ซ่อน Google Apps Script (สร้าง/ลบ/แก้ไข/จัดเรียง Playlist)
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

// 5. ระบบดึงสตรีมวิดีโอตรง (ไร้โฆษณา 100%)
const PIPED_NODES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.projectsegfau.lt'
];

app.get('/api/stream', requireAuth, async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  // ด่านที่ 1: สกัดลิงก์ MP4 ตรงด้วย ytdl-core
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: f => f.hasVideo && f.hasAudio && f.container === 'mp4'
    });
    if (format && format.url) {
      return res.json({ url: format.url, source: 'ytdl-direct' });
    }
  } catch (e) {
    // หากติดข้อจำกัด ให้ข้ามไปด่านที่ 2
  }

  // ด่านที่ 2: ดึงผ่านโหนดสำรอง Piped API
  for (const node of PIPED_NODES) {
    try {
      const response = await fetch(`${node}/streams/${videoId}`, {
        signal: AbortSignal.timeout(3500)
      });
      if (response.ok) {
        const data = await response.json();
        const stream = (data.videoStreams || []).find(s => !s.videoOnly && s.format === 'MPEG_4');
        if (stream && stream.url) {
          return res.json({ url: stream.url, source: 'piped-direct' });
        }
      }
    } catch (e) {}
  }

  res.status(404).json({ error: 'Fallback to AdGuard IFrame' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
