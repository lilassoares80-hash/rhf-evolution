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

// Estado global
let qrState = { qr: null, status: 'idle', ts: 0 };

async function callEvolution(path, method='GET', body=null){
  const opts = { method, headers:{'Content-Type':'application/json','apikey':EVOLUTION_API_KEY} };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return {raw:text}; }
}

// Gerar QR em background — não bloqueia o request
async function gerarQRBackground(){
  try{
    qrState = { qr:null, status:'generating', ts:Date.now() };
    console.log('[BG] Deletando instância...');
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
    await new Promise(r=>setTimeout(r,2000));

    console.log('[BG] Criando instância...');
    const cr = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME, qrcode:true, integration:'WHATSAPP-BAILEYS'
    });
    console.log('[BG] Criada. qrcode field:', JSON.stringify(cr.qrcode));

    // QR na criação?
    const qr0 = cr.qrcode?.base64||cr.instance?.qrcode?.base64;
    if(qr0){ qrState={qr:qr0,status:'ready',ts:Date.now()}; console.log('[BG] QR pronto na criação!'); return; }

    // Polling leve — buscar fetchInstances a cada 3s
    for(let i=0; i<8; i++){
      await new Promise(r=>setTimeout(r,3000));
      const instances = await callEvolution('/instance/fetchInstances?instanceName='+INSTANCE_NAME);
      const inst = Array.isArray(instances)?instances[0]:null;
      if(inst){
        const raw = JSON.stringify(inst);
        // Procurar qualquer string base64 longa (QR code)
        const m = raw.match(/"base64":"(data:image[^"]+)"/);
        if(m){ qrState={qr:m[1],status:'ready',ts:Date.now()}; console.log('[BG] QR encontrado poll '+i); return; }
        // Também verificar sem data:image prefix
        const m2 = raw.match(/"base64":"([A-Za-z0-9+/=]{500,})"/);
        if(m2){ qrState={qr:'data:image/png;base64,'+m2[1],status:'ready',ts:Date.now()}; console.log('[BG] QR base64 puro poll '+i); return; }
        console.log('[BG] Poll '+i+' status:',inst.connectionStatus,'| raw length:',raw.length);
      }
    }
    qrState={qr:null,status:'failed',ts:Date.now()};
    console.log('[BG] QR não gerado após polling');
  }catch(e){
    qrState={qr:null,status:'error',ts:Date.now(),error:e.message};
    console.error('[BG] Erro:',e.message);
  }
}

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    const state = data.instance?.state||data.state||'unknown';
    if(state==='open'){ qrState={qr:null,status:'connected',ts:Date.now()}; }
    res.json({ok:true, state});
  }catch(e){ res.json({ok:false, state:'close', error:e.message}); }
});

// POST /qr/start — inicia geração em background, retorna imediatamente
app.get('/qr/start', (req,res)=>{
  if(qrState.status==='generating' && Date.now()-qrState.ts<30000){
    return res.json({ok:true, status:'generating', message:'Já gerando...'});
  }
  gerarQRBackground(); // não await — background!
  res.json({ok:true, status:'generating', message:'Geração iniciada — chame /qr/status em 5 segundos'});
});

// GET /qr/status — verifica se QR está pronto
app.get('/qr/status', (req,res)=>{
  if(qrState.status==='ready' && qrState.qr && Date.now()-qrState.ts<55000){
    return res.json({ok:true, status:'ready', qr:qrState.qr});
  }
  res.json({ok:false, status:qrState.status, age:Math.round((Date.now()-qrState.ts)/1000)+'s'});
});

// GET /qr — compatibilidade com CRM atual (tenta retornar QR se disponível)
app.get('/qr', async (req,res)=>{
  // Se tem QR pronto
  if(qrState.status==='ready' && qrState.qr && Date.now()-qrState.ts<55000){
    return res.json({ok:true, qr:qrState.qr});
  }
  // Iniciar geração em background
  if(qrState.status!=='generating'){
    gerarQRBackground();
  }
  // Aguardar apenas 8s (dentro do timeout do Railway)
  for(let i=0;i<4;i++){
    await new Promise(r=>setTimeout(r,2000));
    if(qrState.status==='ready' && qrState.qr){
      return res.json({ok:true, qr:qrState.qr});
    }
  }
  res.json({ok:false, error:'QR sendo gerado — clique novamente em 5 segundos', status:qrState.status});
});

app.post('/send', async (req,res)=>{
  try{
    const {phone,message}=req.body;
    if(!phone||!message) return res.status(400).json({ok:false});
    const num=phone.replace(/\D/g,'');
    const data=await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
      number:num.startsWith('55')?num:'55'+num, text:message
    });
    res.json({ok:true,data});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/send-bulk', async (req,res)=>{
  try{
    const {messages}=req.body;
    if(!Array.isArray(messages)) return res.status(400).json({ok:false});
    const results=[];
    for(const m of messages){
      try{
        const num=m.phone.replace(/\D/g,'');
        const data=await callEvolution('/message/sendText/'+INSTANCE_NAME,'POST',{
          number:num.startsWith('55')?num:'55'+num, text:m.message
        });
        results.push({phone:m.phone,ok:true,data});
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){results.push({phone:m.phone,ok:false,error:e.message});}
    }
    res.json({ok:true,results});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/disconnect', async (req,res)=>{
  try{
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE');
    qrState={qr:null,status:'idle',ts:0};
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/debug', async (req,res)=>{
  const state=await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  res.json({evolutionUrl:EVOLUTION_URL,instanceName:INSTANCE_NAME,state,qrState:{...qrState,qr:qrState.qr?'presente':'nenhum'}});
});

app.get('/health', (req,res)=>res.json({ok:true,service:'RHF Evolution Proxy v11',ts:Date.now()}));

app.listen(PORT,()=>console.log('RHF Evolution Proxy v11 porta '+PORT));
