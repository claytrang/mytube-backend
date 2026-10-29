const express=require('express'), cors=require('cors'), {Readable}=require('stream');
const app=express(); app.use(cors()); app.use(express.json());
const GAS_URL=process.env.GAS_URL, APP_PASSWORD=process.env.APP_PASSWORD, YT_API_KEY=process.env.YT_API_KEY;

app.get('/ping',(req,res)=>res.status(200).send('Awake'));
const auth=(req,res,nx)=>{const p=req.headers['x-app-password']||req.query.pass; if(APP_PASSWORD&&p!==APP_PASSWORD)return res.status(401).json({error:'Unauthorized'}); nx();};
app.post('/api/auth',(req,res)=>{if(APP_PASSWORD&&req.body.password===APP_PASSWORD)return res.json({status:'ok'}); res.status(401).json({error:'Invalid'});});
app.get('/api/playlists',auth,async(req,res)=>{try{res.json(await(await fetch(GAS_URL)).json());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/playlists',auth,async(req,res)=>{try{res.json(await(await fetch(GAS_URL,{method:'POST',body:JSON.stringify(req.body)})).json());}catch(e){res.status(500).json({error:e.message});}});

app.get('/api/search',auth,async(req,res)=>{
  try{
    if(!YT_API_KEY) return res.status(500).json({error:'Missing YT_API_KEY in Render'});
    const q=req.query.q; if(!q) return res.status(400).json({error:'No query'});
    const r1=await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q=${encodeURIComponent(q)}&type=video&key=${YT_API_KEY}`);
    const d1=await r1.json(); if(d1.error) return res.status(500).json({error:d1.error.message});
    const ids=d1.items.map(i=>i.id.videoId).join(',');
    const r2=await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YT_API_KEY}`);
    const d2=await r2.json(); const dur={};
    d2.items.forEach(i=>{
      const m=i.contentDetails.duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
      let h=parseInt(m[1])||0, min=parseInt(m[2])||0, s=parseInt(m[3])||0, sec=h*3600+min*60+s;
      dur[i.id]={sec, txt:h>0?`${h}:${min.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`:`${min}:${s.toString().padStart(2,'0')}`};
    });
    res.json({results:d1.items.map(i=>({videoId:i.id.videoId, title:i.snippet.title, author:i.snippet.channelTitle, duration:dur[i.id.videoId]?.txt||'0:00', seconds:dur[i.id.videoId]?.sec||0, thumbnail:i.snippet.thumbnails.high?.url||i.snippet.thumbnails.default?.url}))});
  }catch(e){res.status(500).json({error:e.message});}
});

const COBALT=['https://api.cobalt.tools','https://cobalt-api.kwiatekmiki.com'], INVIDIOUS=['https://inv.tux.pizza','https://inv.nadeko.net'], PIPED=['https://pipedapi.kavin.rocks','https://pipedapi.tokhmi.xyz'];
app.get('/api/stream',auth,async(req,res)=>{
  const id=req.query.id; const q=req.query.quality||'720'; if(!id) return res.status(400).json({error:'Missing id'});
  for(let n of COBALT)try{const r=await fetch(n,{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({url:`https://youtu.be/${id}`,vQuality:q}),signal:AbortSignal.timeout(4000)});if(r.ok){const d=await r.json();if(d.url)return res.json({url:d.url});}}catch(e){}
  for(let n of INVIDIOUS)try{const r=await fetch(`${n}/api/v1/videos/${id}`,{signal:AbortSignal.timeout(3500)});if(r.ok){const d=await r.json();const f=(d.formatStreams||[]).filter(x=>x.container==='mp4').sort((a,b)=>Math.abs((parseInt(a.resolution)||720)-parseInt(q))-Math.abs((parseInt(b.resolution)||720)-parseInt(q)))[0];if(f&&f.url)return res.json({url:f.url});}}catch(e){}
  for(let n of PIPED)try{const r=await fetch(`${n}/streams/${id}`,{signal:AbortSignal.timeout(3500)});if(r.ok){const d=await r.json();const s=(d.videoStreams||[]).filter(x=>!x.videoOnly&&x.format==='MPEG_4').sort((a,b)=>Math.abs((parseInt(a.quality)||720)-parseInt(q))-Math.abs((parseInt(b.quality)||720)-parseInt(q)))[0];if(s&&s.url)return res.json({url:s.url});}}catch(e){}
  res.status(404).json({error:'No stream'});
});

// API ใหม่สำหรับใช้ดึงไฟล์ดาวน์โหลดโดยเฉพาะ
app.get('/api/download',auth,async(req,res)=>{
  const id=req.query.id; const type=req.query.type||'mp4'; if(!id) return res.status(400).json({error:'Missing id'});
  for(let n of COBALT)try{const r=await fetch(n,{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({url:`https://youtu.be/${id}`,vQuality:'720',isAudioOnly:type==='mp3'}),signal:AbortSignal.timeout(4000)});if(r.ok){const d=await r.json();if(d.url)return res.json({url:d.url});}}catch(e){}
  for(let n of PIPED)try{const r=await fetch(`${n}/streams/${id}`,{signal:AbortSignal.timeout(3500)});if(r.ok){const d=await r.json();let s=null;if(type==='mp4')s=(d.videoStreams||[]).find(x=>!x.videoOnly&&x.format==='MPEG_4');else s=(d.audioStreams||[]).find(x=>x.format==='M4A'||x.format==='WEBMA_OPUS');if(s&&s.url)return res.json({url:s.url});}}catch(e){}
  res.status(404).json({error:'Failed'});
});

app.get('/api/proxy-stream',auth,async(req,res)=>{
  try{const u=req.query.url,h={'User-Agent':'Mozilla/5.0'}; if(req.headers.range)h['Range']=req.headers.range; const r=await fetch(u,{headers:h}); res.status(r.status); ['content-type','content-length','content-range','accept-ranges'].forEach(k=>{const v=r.headers.get(k); if(v)res.setHeader(k,v);}); if(r.body)Readable.fromWeb(r.body).pipe(res); else res.end();}catch(e){res.status(500).end();}
});
app.listen(process.env.PORT||3000);
