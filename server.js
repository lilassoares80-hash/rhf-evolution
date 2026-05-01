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
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return { raw: text }; }
}

function extractQR(obj){
  if(!obj) return null;
  // Todos os campos possíveis onde o QR pode estar
  return obj.base64
    || obj.qrcode?.base64
    || obj.instance?.qrcode?.base64
    || obj.hash?.qrcode?.base64
    || obj.qr
    || obj.code
    || (typeof obj.raw === 'string' && obj.raw.startsWith('data:image') ? obj.raw : null);
}

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    res.json({ ok:true, state: data.instance?.state||data.state||'unknown' });
  }catch(e){
    res.json({ ok:false, state:'close', error:e.message });
  }
});

app.get('/qr', async (req,res)=>{
  try{
    console.log('[QR] Iniciando...');

    // Passo 1: Deletar instância existente
    const delRes = await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(e=>({error:e.message}));
    console.log('[QR] Delete:', JSON.stringify(delRes).slice(0,100));
    await new Promise(r=>setTimeout(r,2000));

    // Passo 2: Criar instância nova com qrcode:true
    const createRes = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    });
    console.log('[QR] Create keys:', Object.keys(createRes||{}));
    console.log('[QR] Create full:', JSON.stringify(createRes).slice(0,600));

    // Verificar se QR veio na criação
    const qrFromCreate = extractQR(createRes) || extractQR(createRes.instance) || extractQR(createRes.qrcode);
    if(qrFromCreate){
      console.log('[QR] QR encontrado na criação!');
      return res.json({ ok:true, qr: qrFromCreate });
    }

    // Passo 3: Aguardar e buscar QR no endpoint específico
    await new Promise(r=>setTimeout(r,3000));

    // Tentar endpoint /instance/qrcode/{name}
    const qrRes1 = await callEvolution('/instance/qrcode/'+INSTANCE_NAME);
    console.log('[QR] qrcode endpoint:', JSON.stringify(qrRes1).slice(0,400));
    const qr1 = extractQR(qrRes1);
    if(qr1) return res.json({ ok:true, qr: qr1 });

    // Tentar endpoint /instance/qrcode/{name}?image=true
    const qrRes2 = await callEvolution('/instance/qrcode/'+INSTANCE_NAME+'?image=true');
    console.log('[QR] qrcode?image=true:', JSON.stringify(qrRes2).slice(0,400));
    const qr2 = extractQR(qrRes2);
    if(qr2) return res.json({ ok:true, qr: qr2 });

    // Tentar endpoint /instance/connect/{name}
    const qrRes3 = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] connect:', JSON.stringify(qrRes3).slice(0,400));
    const qr3 = extractQR(qrRes3);
    if(qr3) return res.json({ ok:true, qr: qr3 });

    // Nenhum funcionou — retornar debug completo
    res.json({ 
      ok:false, 
      error:'QR não gerado ainda — tente novamente em 5 segundos',
      debug: { create: createRes, qrcode: qrRes1 }
    });
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
      number: formatted, text: message
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
        const data = await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
          number: num.startsWith('55')?num:'55'+num, text: m.message
        });
        results.push({ phone:m.phone, ok:true, data });
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){ results.push({ phone:m.phone, ok:false, error:e.message }); }
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
