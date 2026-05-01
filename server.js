const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Configurações (via variáveis de ambiente no Railway) ──
const EVOLUTION_URL      = process.env.EVOLUTION_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY || 'rhf-secret-key';
const INSTANCE_NAME      = process.env.INSTANCE_NAME || 'rhf-talentos';
const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://integravagass.netlify.app';

app.use(express.json());
app.use(cors({ origin: [ALLOWED_ORIGIN, 'http://localhost:3000'], credentials: true }));

// ── Helper: chamada à Evolution API ──
async function callEvolution(path, method='GET', body=null){
  const opts = {
    method,
    headers: { 'Content-Type':'application/json', 'apikey': EVOLUTION_API_KEY }
  };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  return res.json();
}

// ── GET /status — verificar se instância está conectada ──
app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    res.json({ ok:true, state: data.instance?.state||'unknown', data });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── GET /qr — obter QR code para conectar ──
app.get('/qr', async (req,res)=>{
  try{
    // Criar instância se não existir
    await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    }).catch(()=>{});
    // Pegar QR
    const data = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    res.json({ ok:true, qr: data.base64||data.qrcode?.base64, data });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── POST /send — enviar mensagem de texto ──
app.post('/send', async (req,res)=>{
  try{
    const { phone, message } = req.body;
    if(!phone||!message) return res.status(400).json({ ok:false, error:'phone e message obrigatórios' });

    // Formatar número: 55 + DDD + número (sem +, sem espaços)
    const num = phone.replace(/\D/g,'');
    const formatted = num.startsWith('55') ? num : '55'+num;

    const data = await callEvolution('/message/sendText/'+INSTANCE_NAME, 'POST', {
      number: formatted,
      text: message
    });
    res.json({ ok:true, data });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── POST /send-bulk — enviar para vários números ──
app.post('/send-bulk', async (req,res)=>{
  try{
    const { messages } = req.body; // [{phone, message}]
    if(!Array.isArray(messages)) return res.status(400).json({ ok:false, error:'messages deve ser array' });

    const results = [];
    for(const m of messages){
      try{
        const num = m.phone.replace(/\D/g,'');
        const formatted = num.startsWith('55') ? num : '55'+num;
        const data = await callEvolution('/message/sendText/'+INSTANCE_NAME, 'POST', {
          number: formatted,
          text: m.message
        });
        results.push({ phone:m.phone, ok:true, data });
        // Delay entre mensagens para não ser bloqueado
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){
        results.push({ phone:m.phone, ok:false, error:e.message });
      }
    }
    res.json({ ok:true, results });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── POST /disconnect — desconectar instância ──
app.post('/disconnect', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/logout/'+INSTANCE_NAME,'DELETE');
    res.json({ ok:true, data });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ── GET /health ──
app.get('/health', (req,res)=>res.json({ ok:true, service:'RHF Evolution Proxy', ts:Date.now() }));

app.listen(PORT, ()=>console.log('RHF Evolution Proxy rodando na porta '+PORT));
