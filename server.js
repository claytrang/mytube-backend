const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// ดึงค่าความลับจาก Environment Variables บน Render
const GAS_URL = process.env.GAS_URL;
const APP_PASSWORD = process.env.APP_PASSWORD;

app.get('/ping', (req, res) => res.status(200).send('Awake'));

function requireAuth(req, res, next) {
  const pass = req.headers['x-app-password'] || req.query.pass;
  if (!APP_PASSWORD || pass !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/auth', (req, res) => {
  if (APP_PASSWORD && req.body.password === APP_PASSWORD) {
    return res.json({ status: 'ok' });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const response = await fetch(GAS_URL);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// โหนดสาธารณะสำหรับค้นหาและดึงวิดีโอ
const PIPED_NODES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.syncpundit.io'
];

const INVIDIOUS_NODES = [
  'https://inv.tux.pizza',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://yewtu.be'
];

const COBALT_NODES = [
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.api.timelessnesses.me'
];

// >>> ระบบค้นหาใหม่ (ดึงผ่าน Public API ไม่พึ่งไลบรารี ไม่ติดลิมิต) <<<
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    let searchResults = null;
    
    // ด่านที่ 1: ลองค้นหาผ่าน Piped API
    for (const node of PIPED_NODES) {
      try {
        const r = await fetch(`${node}/search?q=${encodeURIComponent(query)}&filter=videos`, {
          signal: AbortSignal.timeout(5000)
        });
        if (r.ok) {
          const data = await r.json();
          if (data.items && data.items.length > 0) {
            searchResults = data.items.filter(item => item.type === 'stream');
            break;
          }
        }
      } catch (e) {}
    }

    // ด่านที่ 2: หาก Piped ล่ม ลองผ่าน Invidious API
    if (!searchResults) {
      for (const node of INVIDIOUS_NODES) {
        try {
          const r = await fetch(`${node}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
            signal: AbortSignal.timeout(5000)
          });
          if (r.ok) {
            const data = await r.json();
            if (data && data.length > 0) {
              searchResults = data; 
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (!searchResults || searchResults.length === 0) {
      return res.status(500).json({ error: 'เซิร์ฟเวอร์ค้นหาขัดข้องชั่วคราว กรุณาลองใหม่' });
    }

    // จัดรูปแบบผลลัพธ์ส่งกลับไปให้หน้าเว็บ
    const videos = searchResults.map(v => {
      let videoId = v.videoId;
      if (!videoId && v.url) videoId = v.url.split('v=')[1]; 
      
      let sec = v.duration || v.lengthSeconds || 0;
      let durationFormatted = "0:00";
      if (sec > 0) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
      }

      let thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      if (v.thumbnail) thumb = typeof v.thumbnail === 'string' ? v.thumbnail : v.thumbnail.url;
      if (v.videoThumbnails && v.videoThumbnails.length > 0) thumb = v.videoThumbnails[0].url;

      return {
        videoId: videoId,
        title: v.title,
        author: v.uploaderName || v.author || "YouTube",
        duration: durationFormatted,
        seconds: sec,
        thumbnail: thumb
      };
    });

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ระบบสกัด Direct MP4 Stream
app.get('/api/stream', requireAuth, async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  for (const node of COBALT_NODES) {
    try {
      const r = await fetch(`${node}/`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ytUrl, vQuality: '720' }),
        signal: AbortSignal.timeout(4000)
      });
      if (r.ok) {
        const data = await r.json();
        if (data.url) return res.json({ url: data.url, source: 'cobalt-direct' });
      }
    } catch (e) {}
  }

  for (const node of INVIDIOUS_NODES) {
    try {
      const r = await fetch(`${node}/api/v1/videos/${videoId}`, { signal: AbortSignal.timeout(3500) });
      if (r.ok) {
        const data = await r.json();
        const fmt = (data.formatStreams || []).find(f => f.container === 'mp4');
        if (fmt && fmt.url) return res.json({ url: fmt.url, source: 'invidious-direct', proxyNode: node });
      }
    } catch (e) {}
  }

  for (const node of PIPED_NODES) {
    try {
      const r = await fetch(`${node}/streams/${videoId}`, { signal: AbortSignal.timeout(3500) });
      if (r.ok) {
        const data = await r.json();
        const stream = (data.videoStreams || []).find(s => !s.videoOnly && s.format === 'MPEG_4');
        if (stream && stream.url) return res.json({ url: stream.url, source: 'piped-direct' });
      }
    } catch (e) {}
  }

  res.status(404).json({ error: 'No direct stream available' });
});

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
