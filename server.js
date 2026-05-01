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

// Cache do QR em memória
let cachedQR = null;
let qrExpiry = 0;

async function callEvolution(path, method='GET', body=null){
  const opts = {
    method,
    headers:{'Content-Type':'application/json','apikey':EVOLUTION_API_KEY}
  };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return {raw:text}; }
}

async function fetchQRFromInstance(){
  // fetchInstances traz os dados completos incluindo QR quando disponível
  const instances = await callEvolution('/instance/fetchInstances?instanceName='+INSTANCE_NAME);
  const inst = Array.isArray(instances) ? instances[0] : instances;
  if(!inst) return null;
  
  console.log('[FETCH] Instance keys:', Object.keys(inst||{}));
  console.log('[FETCH] Instance data:', JSON.stringify(inst).slice(0,500));
  
  // Tentar todos os campos
  return inst.qrcode?.base64 
    || inst.qr?.base64
    || inst.hash?.qrcode?.base64
    || inst.connectionStatus?.qrcode?.base64
    || null;
}

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    const state = data.instance?.state||data.state||'unknown';
    if(state==='open'){ cachedQR=null; qrExpiry=0; }
    res.json({ok:true, state});
  }catch(e){ res.json({ok:false, state:'close', error:e.message}); }
});

app.get('/qr', async (req,res)=>{
  try{
    // Retornar cache se válido
    if(cachedQR && Date.now()<qrExpiry){
      return res.json({ok:true, qr:cachedQR});
    }

    console.log('[QR] v10 - Deletando instância...');
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
    await new Promise(r=>setTimeout(r,2000));

    console.log('[QR] Criando instância...');
    const cr = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    });
    
    // QR na resposta da criação?
    const qrCreate = cr.qrcode?.base64||cr.instance?.qrcode?.base64;
    if(qrCreate){
      cachedQR=qrCreate; qrExpiry=Date.now()+55000;
      return res.json({ok:true, qr:qrCreate});
    }

    // Polling: buscar via fetchInstances a cada 2s por até 20s
    console.log('[QR] Iniciando polling de 20s...');
    for(let i=0; i<10; i++){
      await new Promise(r=>setTimeout(r,2000));
      
      // Buscar instância completa
      const instances = await callEvolution('/instance/fetchInstances?instanceName='+INSTANCE_NAME);
      const inst = Array.isArray(instances) ? instances[0] : null;
      
      if(inst){
        const allData = JSON.stringify(inst);
        console.log('[POLL '+i+'] connectionStatus:', inst.connectionStatus, '| has base64:', allData.includes('base64'));
        
        // Procurar base64 em qualquer lugar da resposta
        const match = allData.match(/"base64":"([^"]{100,})"/);
        if(match){
          const qr = match[1];
          console.log('[POLL] QR encontrado!');
          cachedQR=qr; qrExpiry=Date.now()+55000;
          return res.json({ok:true, qr});
        }
      }
      
      // Também tentar connect
      const conn = await callEvolution('/instance/connect/'+INSTANCE_NAME);
      const qrConn = conn.base64||conn.code;
      if(qrConn && qrConn.length>100){
        cachedQR=qrConn; qrExpiry=Date.now()+55000;
        return res.json({ok:true, qr:qrConn});
      }
    }

    res.json({ok:false, error:'QR não gerado em 20s — tente novamente'});
  }catch(e){
    console.error('[QR]',e.message);
    res.status(500).json({ok:false,error:e.message});
  }
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
          number:num.startsWith('55')?num:'55'+num,text:m.message
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
    cachedQR=null; qrExpiry=0;
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/debug', async (req,res)=>{
  const state=await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const instances=await callEvolution('/instance/fetchInstances?instanceName='+INSTANCE_NAME).catch(e=>({error:e.message}));
  const inst=Array.isArray(instances)?instances[0]:instances;
  res.json({
    evolutionUrl:EVOLUTION_URL, instanceName:INSTANCE_NAME,
    state, instanceKeys:inst?Object.keys(inst):[],
    instanceFull:inst, cachedQR:cachedQR?'presente':'nenhum'
  });
});

app.get('/health', (req,res)=>res.json({ok:true,service:'RHF Evolution Proxy v10',ts:Date.now()}));

app.listen(PORT,()=>console.log('RHF Evolution Proxy v10 porta '+PORT));
