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
    headers:{'Content-Type':'application/json','apikey':EVOLUTION_API_KEY}
  };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(EVOLUTION_URL+path, opts);
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return {raw:text}; }
}

app.get('/status', async (req,res)=>{
  try{
    const data = await callEvolution('/instance/connectionState/'+INSTANCE_NAME);
    res.json({ok:true, state:data.instance?.state||data.state||'unknown'});
  }catch(e){ res.json({ok:false, state:'close', error:e.message}); }
});

app.get('/qr', async (req,res)=>{
  try{
    console.log('[QR] Iniciando v8...');

    // Deletar instância
    await callEvolution('/instance/delete/'+INSTANCE_NAME,'DELETE').catch(()=>{});
    await new Promise(r=>setTimeout(r,3000));

    // Criar instância
    const cr = await callEvolution('/instance/create','POST',{
      instanceName: INSTANCE_NAME,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    });
    console.log('[QR] Criada. Keys:', Object.keys(cr));

    // Verificar se QR veio na criação
    const qr0 = cr.qrcode?.base64||cr.instance?.qrcode?.base64||cr.base64;
    if(qr0){ console.log('[QR] QR na criação!'); return res.json({ok:true,qr:qr0}); }

    // Aguardar inicialização
    await new Promise(r=>setTimeout(r,5000));

    // Buscar instância com dados completos
    const instances = await callEvolution('/instance/fetchInstances');
    console.log('[QR] Instâncias:', JSON.stringify(instances).slice(0,500));
    
    const inst = Array.isArray(instances) ? instances.find(i=>i.name===INSTANCE_NAME||i.instanceName===INSTANCE_NAME) : null;
    console.log('[QR] Minha instância keys:', inst ? Object.keys(inst) : 'não encontrada');
    
    // QR pode estar dentro da instância
    const qr1 = inst?.qrcode?.base64||inst?.hash?.qrcode?.base64;
    if(qr1){ return res.json({ok:true,qr:qr1}); }

    // Chamar connect
    const conn = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] Connect completo:', JSON.stringify(conn).slice(0,500));
    
    const qr2 = conn.base64||conn.qrcode?.base64||conn.code||conn.qr;
    if(qr2){ return res.json({ok:true,qr:qr2}); }

    // Aguardar mais e tentar connect de novo
    await new Promise(r=>setTimeout(r,5000));
    const conn2 = await callEvolution('/instance/connect/'+INSTANCE_NAME);
    console.log('[QR] Connect2:', JSON.stringify(conn2).slice(0,300));
    const qr3 = conn2.base64||conn2.qrcode?.base64||conn2.code;
    if(qr3){ return res.json({ok:true,qr:qr3}); }

    res.json({ok:false, error:'QR sendo gerado — clique novamente em 5 segundos', 
      hint:'Verifique os logs do Railway para mais detalhes'});
  }catch(e){
    console.error('[QR]',e.message);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.post('/send', async (req,res)=>{
  try{
    const {phone,message}=req.body;
    if(!phone||!message) return res.status(400).json({ok:false,error:'phone e message obrigatórios'});
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
    await callEvolution('/instance/logout/'+INSTANCE_NAME,'DELETE');
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/debug', async (req,res)=>{
  const state=await callEvolution('/instance/connectionState/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  const instances=await callEvolution('/instance/fetchInstances').catch(e=>({error:e.message}));
  const connect=await callEvolution('/instance/connect/'+INSTANCE_NAME).catch(e=>({error:e.message}));
  res.json({evolutionUrl:EVOLUTION_URL,instanceName:INSTANCE_NAME,state,connect,
    instances:Array.isArray(instances)?instances.map(i=>({name:i.name,status:i.connectionStatus,keys:Object.keys(i)})):instances});
});

app.get('/health', (req,res)=>res.json({ok:true,service:'RHF Evolution Proxy v8',ts:Date.now()}));

app.listen(PORT,()=>console.log('RHF Evolution Proxy v8 porta '+PORT));
