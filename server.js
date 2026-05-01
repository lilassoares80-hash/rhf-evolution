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

async function callEvolution(path, method='GET', body=null){
  const opts = {
    method,
    headers: { 'Content-Type':'application/json', 'apikey': EVOLUTION_API_KEY }
  };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  return res.json();
}

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    res.json({ ok:true, state: data.instance?.state||data.state||'unknown', data });
  }catch(e){
    res.json({ ok:false, state:'close', error:e.message });
  }
});

app.get('/qr', async (req,res)=>{
  try{
    console.log('[QR] Iniciando... Evolution URL:', EVOLUTION_URL);

    // Verificar se instância existe e qual o estado
    const stateRes = await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(()=>null);
    console.log('[QR] Estado atual:', JSON.stringify(stateRes).slice(0,200));

    // Se instância existe mas não está conectada, deletar e recriar
    if(stateRes && !stateRes.error){
      const state = stateRes.instance?.state||stateRes.state||'';
      if(state !== 'open'){
        console.log('[QR] Deletando instância antiga...');
        await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
        await new Promise(r=>setTimeout(r,2000));
      } else {
        return res.json({ ok:true, state:'open', message:'WhatsApp já conectado!' });
      }
    }

    // Criar nova instância
    console.log('[QR] Criando nova instância...');
    const createRes = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    });
    console.log('[QR] Create:', JSON.stringify(createRes).slice(0,300));

    await new Promise(r=>setTimeout(r,2000));

    // Pegar QR
    const connectRes = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] Connect keys:', Object.keys(connectRes||{}));

    const qr = connectRes.base64 || connectRes.qrcode?.base64 || connectRes.code || connectRes.qr;
    if(!qr){
      console.log('[QR] Resposta completa:', JSON.stringify(connectRes).slice(0,500));
      return res.json({ ok:false, error:'QR não gerado ainda — aguarde 5 segundos e tente novamente', data:connectRes });
    }
    res.json({ ok:true, qr });
  }catch(e){
    console.error('[QR] Erro:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/send', async (req,res)=>{
  try{
    const { phone, message } = req.body;
    if(!phone||!message) return res.status(400).json({ ok:false, error:'phone e message obrigatórios' });
    const num = phone.replace(/\D/g,'');
    const formatted = num.startsWith('55') ? num : '55'+num;
    const data = await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
      number: formatted,
      text: message
    });
    res.json({ ok:true, data });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/send-bulk', async (req,res)=>{
  try{
    const { messages } = req.body;
    if(!Array.isArray(messages)) return res.status(400).json({ ok:false, error:'messages deve ser array' });
    const results = [];
    for(const m of messages){
      try{
        const num = m.phone.replace(/\D/g,'');
        const formatted = num.startsWith('55') ? num : '55'+num;
        const data = await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
          number: formatted, text: m.message
        });
        results.push({ phone:m.phone, ok:true, data });
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

app.post('/disconnect', async (req,res)=>{
  try{
    await callEvolution('/instance/logout/'+INSTANCE_NAME,'DELETE');
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/health', (req,res)=>res.json({ ok:true, service:'RHF Evolution Proxy', ts:Date.now() }));

app.listen(PORT, ()=>console.log('RHF Evolution Proxy rodando na porta '+PORT));
