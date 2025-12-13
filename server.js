/**
 * Telegram MTProto Bridge para n8n
 *
 * Este servidor conecta ao Telegram como usuário (MTProto),
 * escuta mensagens e as envia para um webhook do n8n.
 * Também expõe endpoints HTTP para enviar mensagens de volta e listar membros de grupos.
 *
 * @version 1.1.0
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
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }
}

// ============================================
// 🧠 FUNÇÕES AUXILIARES
// ============================================

/**
 * Normaliza o chatId baseado no tipo de chat:
 * - Canal: -100<channelId>
 * - Grupo: -<chatId>
 * - Usuário: <userId>
 */
function normalizeChatId(message) {
  const peerId = message?.peerId;
  if (!peerId) return null;

  if (peerId.channelId) return `-100${peerId.channelId.toString()}`;
  if (peerId.chatId) return `-${peerId.chatId.toString()}`;
  if (peerId.userId) return peerId.userId.toString();

  return null;
}

/**
 * Normaliza a data para ISO-8601
 * Aceita number (timestamp em segundos) ou Date
 */
function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (value instanceof Date) return value.toISOString();
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
 * Extrai senderId
 */
function getSenderId(message) {
  if (message?.senderId) return message.senderId.toString();
  if (message?.fromId?.userId) return message.fromId.userId.toString();
  return null;
}

/**
 * Resolve entidade de chat/grupo/canal a partir de:
 * - @username
 * - -100...
 * - -...
 * - link t.me/...
 */
async function resolveChatEntity(chat) {
  const cleaned = String(chat)
    .trim()
    .replace("https://t.me/", "@")
    .replace("t.me/", "@");

  return await client.getEntity(cleaned);
}

/**
 * Lista participantes com paginação (pode falhar em grupos gigantes/privacidade).
 */
async function listAllParticipants(entity, max = 5000) {
  const participants = [];
  let offset = 0;
  const chunk = 200;

  while (participants.length < max) {
    const res = await client.getParticipants(entity, {
      offset,
      limit: Math.min(chunk, max - participants.length),
      aggressive: true,
    });

    if (!res || res.length === 0) break;

    participants.push(...res);
    offset += res.length;

    if (res.length < chunk) break;
  }

  return participants;
}

// ============================================
// 📱 CLIENTE TELEGRAM
// ============================================

let client = null;
let isConnected = false;

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
        error: "Token inválido ou ausente",
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

    if (!chatId || !text) {
      return res.status(400).json({
        ok: false,
        error: "Campos 'chatId' e 'text' são obrigatórios",
      });
    }

    if (!isConnected || !client) {
      return res.status(503).json({
        ok: false,
        error: "Cliente Telegram não conectado",
      });
    }

    console.log(`📤 Enviando mensagem para Telegram: chatId=${chatId}`);
    await client.sendMessage(chatId, { message: text });
    console.log(`✅ Mensagem enviada com sucesso para ${chatId}`);

    return res.json({ ok: true });
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /group-members?chat=@grupo&limit=2000
 * Retorna lista de membros (quando permitido pelo Telegram).
 */
app.get("/group-members", authMiddleware, async (req, res) => {
  try {
    const chat = req.query.chat;
    const limit = parseInt(req.query.limit || "5000", 10);

    if (!chat) {
      return res.status(400).json({ ok: false, error: "Query param 'chat' é obrigatório" });
    }
    if (!isConnected || !client) {
      return res.status(503).json({ ok: false, error: "Cliente Telegram não conectado" });
    }

    const entity = await resolveChatEntity(chat);
    const users = await listAllParticipants(entity, limit);

    const members = users.map((u) => ({
      id: u?.id?.toString?.() || null,
      username: u?.username || null,
      firstName: u?.firstName || null,
      lastName: u?.lastName || null,
      phone: u?.phone || null, // pode vir vazio por privacidade
      bot: !!u?.bot,
      deleted: !!u?.deleted,
    }));

    return res.json({
      ok: true,
      chat: String(chat),
      count: members.length,
      members,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /health
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
 */
app.get("/", (req, res) => {
  res.json({
    name: "Telegram MTProto Bridge",
    version: "1.1.0",
    status: isConnected ? "connected" : "disconnected",
    endpoints: {
      health: "GET /health",
      sendMessage: "POST /send-message",
      groupMembers: "GET /group-members?chat=@grupo&limit=2000",
    },
  });
});

// ============================================
// 📥 LISTENER DE MENSAGENS
// ============================================

function registerMessageListener() {
  client.addEventHandler(
    async (event) => {
      try {
        const message = event?.message;

        const text = message?.message || message?.text;
        if (!message || !text) return;

        const chatId = normalizeChatId(message);
        if (!chatId) return;

        const date = normalizeDate(message.date);
        const senderId = getSenderId(message);

        console.log(`📨 Mensagem recebida: chatId=${chatId}, texto="${text.substring(0, 50)}..."`);

        await sendToN8n({
          source: "telegram-client",
          chatId,
          text,
          date,
          senderId,
        });
      } catch (error) {
        console.error("❌ Erro ao processar mensagem:", error.message);
      }
    },
    new NewMessage({})
  );

  console.log("👂 Listener de mensagens registrado");
}

// ============================================
// 🚀 INICIALIZAÇÃO
// ============================================

let server = null;

async function initTelegram() {
  console.log("🔄 Iniciando conexão com Telegram...");

  const session = new StringSession(CONFIG.stringSession);

  client = new TelegramClient(session, CONFIG.apiId, CONFIG.apiHash, {
    connectionRetries: 5,
    useWSS: false,
  });

  if (!CONFIG.stringSession) {
    console.log("📲 Nenhuma session encontrada. Iniciando login...\n");

    await client.start({
      phoneNumber: async () =>
        await input.text("📱 Digite seu telefone (com DDI, ex: +5511999999999): "),
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
    await client.connect();
    console.log("✅ Conectado ao Telegram com session existente");
  }

  isConnected = true;

  registerMessageListener();
  return client;
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("   🚀 TELEGRAM MTPROTO BRIDGE PARA N8N");
  console.log("=".repeat(60) + "\n");

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
    await initTelegram();

    server = app.listen(CONFIG.port, () => {
      console.log(`\n🌐 Servidor HTTP rodando em http://localhost:${CONFIG.port}`);
      console.log(`   - Health: GET http://localhost:${CONFIG.port}/health`);
      console.log(`   - Enviar: POST http://localhost:${CONFIG.port}/send-message`);
      console.log(`   - Membros: GET http://localhost:${CONFIG.port}/group-members?chat=@grupo&limit=2000`);
      console.log("\n✅ Bridge pronto para uso!\n");
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`❌ Porta ${CONFIG.port} já está em uso. Troque a PORT ou mate o processo.`);
      } else {
        console.error("❌ Erro no servidor HTTP:", err.message);
      }
      process.exit(1);
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
  try {
    if (server) server.close();
    if (client) await client.disconnect();
  } finally {
    process.exit(0);
  }
});

// Executar
main();
