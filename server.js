/**
 * Telegram MTProto Bridge para n8n
 * 
 * Este servidor conecta ao Telegram como usuário (MTProto),
 * escuta mensagens e as envia para um webhook do n8n.
 * Também expõe um endpoint HTTP para o n8n enviar mensagens de volta.
 * 
 * @author Lovable AI
 * @version 1.0.0
 */

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require("express");
const axios = require("axios");
const input = require("input");

// ============================================
// 🔐 CONFIGURAÇÃO VIA VARIÁVEIS DE AMBIENTE
// ============================================

const CONFIG = {
  apiId: parseInt(process.env.TG_API_ID, 10),
  apiHash: process.env.TG_API_HASH,
  stringSession: process.env.TG_STRING_SESSION || "",
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
  port: parseInt(process.env.PORT, 10) || 3000,
  bridgeToken: process.env.BRIDGE_TOKEN || null,
};

// Validação de configuração obrigatória
function validateConfig() {
  const errors = [];
  if (!CONFIG.apiId) errors.push("TG_API_ID é obrigatório");
  if (!CONFIG.apiHash) errors.push("TG_API_HASH é obrigatório");
  if (!CONFIG.n8nWebhookUrl) errors.push("N8N_WEBHOOK_URL é obrigatório");
  
  if (errors.length > 0) {
    console.error("❌ Erros de configuração:");
    errors.forEach(e => console.error(`   - ${e}`));
    process.exit(1);
  }
}

// ============================================
// 🧠 FUNÇÕES AUXILIARES
// ============================================

/**
 * Normaliza o chatId baseado no tipo de chat
 * - Canal: -100<channelId>
 * - Grupo: -<chatId>
 * - Usuário: <userId>
 */
function normalizeChatId(message) {
  const peerId = message.peerId;
  
  if (!peerId) return null;
  
  // Canal (channelId)
  if (peerId.channelId) {
    return `-100${peerId.channelId.toString()}`;
  }
  
  // Grupo (chatId)
  if (peerId.chatId) {
    return `-${peerId.chatId.toString()}`;
  }
  
  // Usuário (userId)
  if (peerId.userId) {
    return peerId.userId.toString();
  }
  
  return null;
}

/**
 * Normaliza a data para formato ISO-8601
 * Aceita number (timestamp) ou Date
 */
function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  
  // Se for número (timestamp em segundos do Telegram)
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }
  
  // Se já for Date
  if (value instanceof Date) {
    return value.toISOString();
  }
  
  // Fallback
  return new Date().toISOString();
}

/**
 * Envia payload para o webhook do n8n
 */
async function sendToN8n(payload) {
  try {
    console.log(`📤 Enviando para n8n: chatId=${payload.chatId}`);
    
    const response = await axios.post(CONFIG.n8nWebhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });
    
    console.log(`✅ Enviado para n8n com sucesso (status: ${response.status})`);
    return true;
  } catch (error) {
    console.error(`❌ Erro ao enviar para n8n: ${error.message}`);
    return false;
  }
}

/**
 * Extrai o senderId da mensagem
 */
function getSenderId(message) {
  if (message.senderId) {
    return message.senderId.toString();
  }
  if (message.fromId?.userId) {
    return message.fromId.userId.toString();
  }
  return null;
}

// ============================================
// 📱 CLIENTE TELEGRAM
// ============================================

let client = null;
let isConnected = false;

async function initTelegram() {
  console.log("🔄 Iniciando conexão com Telegram...");
  
  const session = new StringSession(CONFIG.stringSession);
  
  client = new TelegramClient(session, CONFIG.apiId, CONFIG.apiHash, {
    connectionRetries: 5,
    useWSS: false,
  });
  
  // Se não tem session, fazer login interativo
  if (!CONFIG.stringSession) {
    console.log("📲 Nenhuma session encontrada. Iniciando login...\n");
    
    await client.start({
      phoneNumber: async () => await input.text("📱 Digite seu telefone (com DDI, ex: +5511999999999): "),
      password: async () => await input.text("🔐 Digite sua senha 2FA (se houver): "),
      phoneCode: async () => await input.text("💬 Digite o código recebido: "),
      onError: (err) => console.error("❌ Erro no login:", err),
    });
    
    const newSession = client.session.save();
    console.log("\n" + "=".repeat(60));
    console.log("✅ LOGIN REALIZADO COM SUCESSO!");
    console.log("=".repeat(60));
    console.log("\n📋 Copie a session abaixo para usar nas próximas execuções:\n");
    console.log(`TG_STRING_SESSION=${newSession}`);
    console.log("\n" + "=".repeat(60) + "\n");
  } else {
    // Conectar com session existente
    await client.connect();
    console.log("✅ Conectado ao Telegram com session existente");
  }
  
  isConnected = true;
  
  // Registrar listener de mensagens
  registerMessageListener();
  
  return client;
}

// ============================================
// 📥 LISTENER DE MENSAGENS
// ============================================

function registerMessageListener() {
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      
      // Ignorar mensagens sem texto
      if (!message || !message.text) {
        return;
      }
      
      const chatId = normalizeChatId(message);
      const text = message.text;
      const date = normalizeDate(message.date);
      const senderId = getSenderId(message);
      
      console.log(`📨 Mensagem recebida: chatId=${chatId}, texto="${text.substring(0, 50)}..."`);
      
      // Montar payload para n8n
      const payload = {
        source: "telegram-client",
        chatId: chatId,
        text: text,
        date: date,
        senderId: senderId,
      };
      
      // Enviar para n8n
      await sendToN8n(payload);
      
    } catch (error) {
      console.error("❌ Erro ao processar mensagem:", error.message);
    }
  }, new NewMessage({}));
  
  console.log("👂 Listener de mensagens registrado");
}

// ============================================
// 🌐 SERVIDOR HTTP (EXPRESS)
// ============================================

const app = express();
app.use(express.json());

/**
 * Middleware para validar BRIDGE_TOKEN (se configurado)
 */
function authMiddleware(req, res, next) {
  if (CONFIG.bridgeToken) {
    const token = req.headers["x-bridge-token"];
    
    if (!token || token !== CONFIG.bridgeToken) {
      console.warn("⚠️ Tentativa de acesso sem token válido");
      return res.status(401).json({ 
        ok: false, 
        error: "Token inválido ou ausente" 
      });
    }
  }
  next();
}

/**
 * POST /send-message
 * Recebe mensagem do n8n e envia para o Telegram
 */
app.post("/send-message", authMiddleware, async (req, res) => {
  try {
    const { chatId, text } = req.body;
    
    // Validar campos obrigatórios
    if (!chatId || !text) {
      return res.status(400).json({ 
        ok: false, 
        error: "Campos 'chatId' e 'text' são obrigatórios" 
      });
    }
    
    // Verificar conexão
    if (!isConnected || !client) {
      return res.status(503).json({ 
        ok: false, 
        error: "Cliente Telegram não conectado" 
      });
    }
    
    console.log(`📤 Enviando mensagem para Telegram: chatId=${chatId}`);
    
    // Enviar via MTProto
    await client.sendMessage(chatId, { message: text });
    
    console.log(`✅ Mensagem enviada com sucesso para ${chatId}`);
    
    return res.json({ ok: true });
    
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.message);
    return res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connected: isConnected,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /
 * Rota raiz com informações básicas
 */
app.get("/", (req, res) => {
  res.json({
    name: "Telegram MTProto Bridge",
    version: "1.0.0",
    status: isConnected ? "connected" : "disconnected",
    endpoints: {
      health: "GET /health",
      sendMessage: "POST /send-message",
    },
  });
});

// ============================================
// 🚀 INICIALIZAÇÃO
// ============================================

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("   🚀 TELEGRAM MTPROTO BRIDGE PARA N8N");
  console.log("=".repeat(60) + "\n");
  
  // Validar configuração
  validateConfig();
  
  console.log("📋 Configuração:");
  console.log(`   - API ID: ${CONFIG.apiId}`);
  console.log(`   - API Hash: ${CONFIG.apiHash.substring(0, 6)}...`);
  console.log(`   - Session: ${CONFIG.stringSession ? "✅ Configurada" : "❌ Vazia (login necessário)"}`);
  console.log(`   - Webhook n8n: ${CONFIG.n8nWebhookUrl}`);
  console.log(`   - Porta HTTP: ${CONFIG.port}`);
  console.log(`   - Token: ${CONFIG.bridgeToken ? "✅ Configurado" : "❌ Desabilitado"}`);
  console.log("");
  
  try {
    // Iniciar cliente Telegram
    await initTelegram();
    
    // Iniciar servidor HTTP
    app.listen(CONFIG.port, () => {
      console.log(`\n🌐 Servidor HTTP rodando em http://localhost:${CONFIG.port}`);
      console.log(`   - Health: GET http://localhost:${CONFIG.port}/health`);
      console.log(`   - Enviar: POST http://localhost:${CONFIG.port}/send-message`);
      console.log("\n✅ Bridge pronto para uso!\n");
    });
    
  } catch (error) {
    console.error("❌ Erro fatal:", error.message);
    process.exit(1);
  }
}

// Tratamento de erros não capturados
process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promise rejeitada:", error);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Encerrando...");
  if (client) {
    await client.disconnect();
  }
  process.exit(0);
});

// Executar
main();
