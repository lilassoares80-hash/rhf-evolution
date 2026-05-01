const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const EVOLUTION_URL     = process.env.EVOLUTION_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'rhf-key-2024';
const INSTANCE_NAME     = process.env.INSTANCE_NAME || 'rhf-talentos';
const WEBHOOK_URL       = process.env.WEBHOOK_URL || '';

app.use(express.json());
app.use(cors({ origin: '*', credentials: false }));

let cachedQR = null;
let qrTimestamp = 0;

async function callEvolution(path, method='GET', body=null){
  const opts = {
    method,
    headers: { 'Content-Type':'application/json', 'apikey': EVOLUTION_API_KEY }
  };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return { raw: text }; }
}

// Webhook recebe QR da Evolution API
app.post('/webhook', (req,res)=>{
  const body = req.body;
  console.log('[WEBHOOK] evento:', body.event);
  const qr = body.data?.qrcode?.base64 
    || body.data?.base64 
    || body.qrcode?.base64
    || body.base64;
  if(qr){
    cachedQR = qr;
    qrTimestamp = Date.now();
    console.log('[WEBHOOK] QR armazenado!');
  }
  res.json({ ok:true });
});

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    const state = data.instance?.state||data.state||'unknown';
    if(state==='open') cachedQR=null;
    res.json({ ok:true, state });
  }catch(e){ res.json({ ok:false, state:'close', error:e.message }); }
});

app.get('/qr', async (req,res)=>{
  try{
    // Retornar QR do cache se válido
    if(cachedQR && Date.now()-qrTimestamp < 55000){
      return res.json({ ok:true, qr: cachedQR });
    }

    // Deletar instância antiga
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
    await new Promise(r=>setTimeout(r,2000));

    // Criar com webhook configurado
    const createRes = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: WEBHOOK_URL ? {
        url: WEBHOOK_URL+'/webhook',
        byEvents: true,
        base64: true,
        events: ['QRCODE_UPDATED','CONNECTION_UPDATE']
      } : undefined
    });
    console.log('[QR] Instância criada');

    // QR na criação?
    const qrC = createRes.qrcode?.base64||createRes.instance?.qrcode?.base64;
    if(qrC){ cachedQR=qrC; qrTimestamp=Date.now(); return res.json({ ok:true, qr:qrC }); }

    // Configurar webhook separadamente se não veio na criação
    if(WEBHOOK_URL){
      await callEvolution('/webhook/set/'+INSTANCE_NAME,'POST',{
        url: WEBHOOK_URL+'/webhook',
        byEvents: true,
        base64: true,
        enabled: true,
        events: ['QRCODE_UPDATED','CONNECTION_UPDATE']
      }).catch(e=>console.log('[WEBHOOK SET]',e.message));
    }

    // Chamar connect para gerar QR
    await new Promise(r=>setTimeout(r,2000));
    const connectRes = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] Connect:', JSON.stringify(connectRes).slice(0,200));

    const qrConn = connectRes.base64||connectRes.qrcode?.base64||connectRes.code;
    if(qrConn){ cachedQR=qrConn; qrTimestamp=Date.now(); return res.json({ ok:true, qr:qrConn }); }

    // Aguardar webhook trazer o QR
    await new Promise(r=>setTimeout(r,5000));
    if(cachedQR && Date.now()-qrTimestamp < 55000){
      return res.json({ ok:true, qr: cachedQR });
    }

    res.json({ ok:false, error:'QR sendo gerado — clique novamente em 5 segundos' });
  }catch(e){
    console.error('[QR]',e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/qr/fetch', async (req,res)=>{
  if(cachedQR && Date.now()-qrTimestamp < 55000) return res.json({ ok:true, qr:cachedQR });
  // Tentar pegar QR direto
  const r = await callEvolution('/instance/connect/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const qr = r.base64||r.qrcode?.base64||r.code;
  if(qr){ cachedQR=qr; qrTimestamp=Date.now(); return res.json({ ok:true, qr }); }
  // Aguardar webhook
  await new Promise(r2=>setTimeout(r2,3000));
  if(cachedQR && Date.now()-qrTimestamp < 55000) return res.json({ ok:true, qr:cachedQR });
  res.json({ ok:false, error:'QR não disponível ainda' });
});

app.post('/send', async (req,res)=>{
  try{
    const { phone, message } = req.body;
    if(!phone||!message) return res.status(400).json({ ok:false, error:'phone e message obrigatórios' });
    const num = phone.replace(/\D/g,'');
    const data = await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
      number: num.startsWith('55')?num:'55'+num, text: message
    });
    res.json({ ok:true, data });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/send-bulk', async (req,res)=>{
  try{
    const { messages } = req.body;
    if(!Array.isArray(messages)) return res.status(400).json({ ok:false });
    const results = [];
    for(const m of messages){
      try{
        const num = m.phone.replace(/\D/g,'');
        const data = await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
          number: num.startsWith('55')?num:'55'+num, text: m.message
        });
        results.push({ phone:m.phone, ok:true, data });
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){ results.push({ phone:m.phone, ok:false, error:e.message }); }
    }
    res.json({ ok:true, results });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/disconnect', async (req,res)=>{
  try{
    await callEvolution('/instance/logout/'+INSTANCE_NAME,'DELETE');
    cachedQR=null;
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/debug', async (req,res)=>{
  const state = await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const instances = await callEvolution('/instance/fetchInstances').catch(e=>({error:e.message}));
  // Verificar webhook configurado
  const webhook = await callEvolution('/webhook/find/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  res.json({ 
    evolutionUrl: EVOLUTION_URL,
    webhookUrl: WEBHOOK_URL,
    instanceName: INSTANCE_NAME,
    state, webhook,
    cachedQR: cachedQR ? 'presente ('+Math.round((Date.now()-qrTimestamp)/1000)+'s atrás)' : 'nenhum'
  });
});

app.get('/health', (req,res)=>res.json({ ok:true, service:'RHF Evolution Proxy v7', ts:Date.now() }));

app.listen(PORT, ()=>console.log('RHF Evolution Proxy v7 rodando na porta '+PORT));
