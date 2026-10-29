const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

const app = express();
app.use(cors());

app.get('/ping', (req, res) => res.status(200).send('Awake'));

app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const r = await yts(query);
    const videos = r.videos.slice(0, 12).map(v => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author.name,
      duration: v.timestamp,
      thumbnail: v.thumbnail
    }));

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
