# RHF Evolution Proxy

Servidor proxy para integrar WhatsApp (via Evolution API) com o CRM RHF Talentos.

## Deploy no Railway (gratuito)

### 1. Criar conta
- Acesse **railway.app** e entre com sua conta GitHub

### 2. Novo projeto
- Clique em **New Project → Deploy from GitHub repo**
- Selecione este repositório

### 3. Adicionar Evolution API
- No mesmo projeto, clique em **New Service → Docker Image**
- Imagem: `atendai/evolution-api:latest`
- Adicione as variáveis de ambiente:
  ```
  AUTHENTICATION_API_KEY=rhf-secret-key-2024
  AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
  ```

### 4. Variáveis de ambiente do proxy (seu servidor Node)
```
EVOLUTION_URL=https://sua-evolution-api.railway.app
EVOLUTION_API_KEY=rhf-secret-key-2024
INSTANCE_NAME=rhf-talentos
ALLOWED_ORIGIN=https://integravagass.netlify.app
```

### 5. No CRM
- Vá em Configurações → WhatsApp
- Cole a URL do servidor proxy (ex: https://rhf-proxy.railway.app)
- Clique em "Conectar" e leia o QR Code

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /health | Status do servidor |
| GET | /status | Estado da conexão WhatsApp |
| GET | /qr | QR Code para conectar |
| POST | /send | Enviar mensagem `{phone, message}` |
| POST | /send-bulk | Enviar em massa `{messages:[{phone,message}]}` |
| POST | /disconnect | Desconectar WhatsApp |
