const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

const EVOLUTION_URL     = process.env.EVOLUTION_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'rhf-key-2024';
const INSTANCE_NAME     = process.env.INSTANCE_NAME || 'rhf-talentos';

app.use(express.json());
app.use(cors({ origin: '*', credentials: false }));

// Armazenar QR em memória quando chegar via webhook
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

// Webhook da Evolution API envia o QR aqui
app.post('/webhook', (req,res)=>{
  const body = req.body;
  console.log('[WEBHOOK] Evento:', body.event, '| Keys:', Object.keys(body));
  if(body.event === 'qrcode.updated'){
    const qr = body.data?.qrcode?.base64 || body.data?.base64 || body.qrcode?.base64;
    if(qr){
      cachedQR = qr;
      qrTimestamp = Date.now();
      console.log('[WEBHOOK] QR recebido e armazenado!');
    }
  }
  res.json({ ok:true });
});

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    const state = data.instance?.state||data.state||'unknown';
    if(state === 'open') cachedQR = null; // Limpar QR se conectado
    res.json({ ok:true, state });
  }catch(e){
    res.json({ ok:false, state:'close', error:e.message });
  }
});

app.get('/qr', async (req,res)=>{
  try{
    console.log('[QR] Iniciando...');

    // Verificar se já tem QR em cache (menos de 60s)
    if(cachedQR && Date.now()-qrTimestamp < 60000){
      console.log('[QR] Retornando QR do cache!');
      return res.json({ ok:true, qr: cachedQR });
    }

    // Deletar e recriar instância com webhook apontando para cá
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
    await new Promise(r=>setTimeout(r,2000));

    const webhookUrl = process.env.WEBHOOK_URL || '';
    const createBody = {
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    };

    // Adicionar webhook se URL configurada
    if(webhookUrl){
      createBody.webhook = {
        url: webhookUrl+'/webhook',
        byEvents: true,
        base64: true,
        events: ['QRCODE_UPDATED','CONNECTION_UPDATE','MESSAGES_UPSERT']
      };
    }

    const createRes = await callEvolution('/instance/create','POST', createBody);
    console.log('[QR] Create status:', createRes.instance?.status);
    
    // QR pode vir direto na criação
    const qrCreate = createRes.qrcode?.base64 || createRes.instance?.qrcode?.base64;
    if(qrCreate){
      cachedQR = qrCreate;
      qrTimestamp = Date.now();
      return res.json({ ok:true, qr: qrCreate });
    }

    // Aguardar e tentar connect
    await new Promise(r=>setTimeout(r,5000));
    
    const connectRes = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] Connect full:', JSON.stringify(connectRes).slice(0,400));
    
    const qrConnect = connectRes.base64 || connectRes.qrcode?.base64 || connectRes.code;
    if(qrConnect){
      cachedQR = qrConnect;
      qrTimestamp = Date.now();
      return res.json({ ok:true, qr: qrConnect });
    }

    // Se tem QR no cache do webhook
    if(cachedQR && Date.now()-qrTimestamp < 60000){
      return res.json({ ok:true, qr: cachedQR });
    }

    res.json({ ok:false, error:'QR sendo gerado — clique novamente em 5 segundos' });
  }catch(e){
    console.error('[QR] Erro:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/qr/fetch', async (req,res)=>{
  // Só busca QR sem recriar
  if(cachedQR && Date.now()-qrTimestamp < 60000){
    return res.json({ ok:true, qr: cachedQR });
  }
  const connectRes = await callEvolution('/instance/connect/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const qr = connectRes.base64 || connectRes.qrcode?.base64 || connectRes.code;
  if(qr){ cachedQR=qr; qrTimestamp=Date.now(); return res.json({ ok:true, qr }); }
  res.json({ ok:false, error:'QR não disponível', data:connectRes });
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
    cachedQR = null;
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Endpoint de diagnóstico
app.get('/debug', async (req,res)=>{
  const state = await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const instances = await callEvolution('/instance/fetchInstances').catch(e=>({error:e.message}));
  res.json({ 
    evolutionUrl: EVOLUTION_URL,
    instanceName: INSTANCE_NAME,
    state, instances,
    cachedQR: cachedQR ? 'presente ('+Math.round((Date.now()-qrTimestamp)/1000)+'s atrás)' : 'nenhum'
  });
});

app.get('/health', (req,res)=>res.json({ ok:true, service:'RHF Evolution Proxy v6', ts:Date.now() }));

app.listen(PORT, ()=>console.log('RHF Evolution Proxy rodando na porta '+PORT));
