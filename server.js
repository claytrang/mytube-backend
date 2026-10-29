const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

const app = express();
app.use(cors());

// สำหรับ Cron-job.org เรียกปลุกเซิร์ฟเวอร์
app.get('/ping', (req, res) => res.status(200).send('Awake'));

// 1. ค้นหาวิดีโอ (แสดงผลสูงสุดทั้งหมดที่ดึงได้ ~40-50 รายการ)
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const r = await yts(query);
    // เอา .slice(0, 12) ออก เพื่อให้แสดงผลสูงสุดทั้งหมด
    const videos = r.videos.map(v => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author.name,
      duration: v.timestamp,
      seconds: v.seconds, // ส่งความยาวจริง (วินาที) ไปช่วยตรวจจับโฆษณาที่หน้าบ้าน
      thumbnail: v.thumbnail
    }));

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ดึง Direct MP4 Stream ผ่าน Piped/Invidious Public Nodes (ไร้โฆษณา 100%)
const STREAM_NODES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me'
];

app.get('/api/stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  for (const node of STREAM_NODES) {
    try {
      const response = await fetch(`${node}/streams/${videoId}`, {
        signal: AbortSignal.timeout(4000)
      });
      if (response.ok) {
        const data = await response.json();
        // ค้นหาสตรีมวิดีโอที่มีทั้งภาพและเสียงในตัว
        const stream = (data.videoStreams || []).find(s => !s.videoOnly && s.format === 'MPEG_4');
        if (stream && stream.url) {
          return res.json({ url: stream.url, source: 'direct' });
        }
      }
    } catch (e) {
      // หากโหนดแรกช้าหรือล่ม จะข้ามไปโหนดถัดไปอัตโนมัติ
    }
  }
  res.status(404).json({ error: 'Fallback to IFrame' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
