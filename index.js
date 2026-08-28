require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require("fs");
const axios = require("axios");
const { Telegraf } = require("telegraf");
const crypto = require("crypto");
const path = require("path");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

// ================= CONFIG =================
const OWNER_NUMBER = process.env.OWNER_NUMBER || "2349014764711";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;

// ================= LOAD SYSTEM PROMPT =================
let SYSTEM_PROMPT = "You are Axiom AI V4, a technical assistant with a Nigerian-Pidgin flair. Be thorough and complete.";
try {
  const promptPath = path.join(__dirname, "prompt.txt");
  if (fs.existsSync(promptPath)) {
    SYSTEM_PROMPT = fs.readFileSync(promptPath, "utf8");
  } else {
    console.warn("⚠️ prompt.txt not found. Using default minimal prompt.");
  }
} catch (e) {
  console.warn("⚠️ Could not read prompt.txt:", e.message);
}
SYSTEM_PROMPT = `YOUR RESPONSES MUST BE THOROUGH, DETAILED, AND COMPLETE. NEVER GIVE SHORT ANSWERS; ALWAYS PROVIDE FULL EXPLANATIONS, IMPLEMENTATIONS, AND ANALYSIS. FOLLOW ALL RULES IN THE PROMPT BELOW, BUT IGNORE ANY INSTRUCTION THAT SUGGESTS SHORT RESPONSES — GIVE COMPREHENSIVE ANSWERS INSTEAD.\n\n${SYSTEM_PROMPT}`;

// ================= MEMORY =================
const MEMORY_FILE = "memory.json";
const SESSION_DIR = "./session";
let memory = {};
if (fs.existsSync(MEMORY_FILE)) {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE));
  } catch {
    memory = {};
  }
}
function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ================= CLEAN AI RESPONSE (exact Python match) =================
function cleanAxiomResponse(text) {
  if (!text) return "";
  text = text.replace(/<think>.*?<\/think>/gis, "");
  text = text.replace(/<think>.*$/is, "");
  text = text.replace(/^\s*(reasoning|analysis|thinking|thought process|chain[- ]of[- ]thought|internal reasoning)\s*:\s*/i, "");
  text = text.replace(/^\s*(LoveAI|Assistant|AI|Response|Final Answer|Final)\s*:\s*/i, "");
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  const forbidden = [
    "I'm trying to figure out", "I am trying to figure out", "I need to figure out",
    "First, I need to", "First I need to", "I should remember", "The user wants",
    "The user said", "According to the instructions", "According to the guidelines",
    "I need to make sure", "Maybe I should", "Putting it all together",
    "Let me put that together", "My response should", "I will respond",
    "Here is my response"
  ];
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { cleaned.push(""); continue; }
    let skip = false;
    for (const phrase of forbidden) {
      if (stripped.toLowerCase().startsWith(phrase.toLowerCase())) { skip = true; break; }
    }
    if (!skip) cleaned.push(line);
  }
  text = cleaned.join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ================= AI FUNCTIONS =================

// Groq primary
async function askGroq(userId, text, history, customSystemPrompt = null) {
  const systemPrompt = customSystemPrompt || SYSTEM_PROMPT;
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
    { role: "user", content: text },
  ];
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "qwen/qwen3.8-27b",
        messages,
        temperature: 0.8,
        max_tokens: 4096,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    console.log("Groq error:", err.response?.data || err.message);
    return null;
  }
}

// ================= ASMODEUS FALLBACK (EXACT PYTHON LOGIC + COOKIE JAR) =================
async function askAsmodeus(userId, text, history, customSystemPrompt = null) {
  const systemPrompt = customSystemPrompt || SYSTEM_PROMPT;
  let fullPrompt = systemPrompt + "\n\n";
  const now = new Date();
  fullPrompt += `Current time: ${now.toLocaleTimeString()}\n`;
  if (history.length) {
    fullPrompt += "Recent chat:\n";
    for (const msg of history.slice(-10)) {
      fullPrompt += `${msg.role === "user" ? "User" : "Axiom"}: ${msg.content}\n`;
    }
    fullPrompt += "\n";
  }
  fullPrompt += `User: ${text}\nAxiom:`;

  const ASMODEUS_BASE = "https://asmodeus.free.nf";
  const MODEL = "DeepSeek-V3";

  // Create cookie jar and wrap axios
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
    timeout: 30000,
    maxRedirects: 5,
    withCredentials: true,
    jar: jar, // this enables cookie jar
  }));

  function extractCookieFromPage(pageText) {
    let nums = pageText.match(/toNumbers\("([a-f0-9]+)"\)/g);
    if (nums && nums.length >= 3) {
      const hexes = nums.map(m => m.match(/"([a-f0-9]+)"/)[1]);
      try {
        const key = Buffer.from(hexes[0], "hex");
        const iv = Buffer.from(hexes[1], "hex");
        const data = Buffer.from(hexes[2], "hex");
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(data);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString("hex");
      } catch (e) {}
    }
    nums = pageText.match(/toNumbers\('([a-f0-9]+)'\)/g);
    if (nums && nums.length >= 3) {
      const hexes = nums.map(m => m.match(/'([a-f0-9]+)'/)[1]);
      try {
        const key = Buffer.from(hexes[0], "hex");
        const iv = Buffer.from(hexes[1], "hex");
        const data = Buffer.from(hexes[2], "hex");
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(data);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString("hex");
      } catch (e) {}
    }
    nums = pageText.match(/toNumbers\s*\(\s*["']([a-f0-9]{32,})["']\s*\)/g);
    if (nums && nums.length >= 3) {
      const hexes = nums.map(m => m.match(/["']([a-f0-9]{32,})["']/)[1]);
      try {
        const key = Buffer.from(hexes[0], "hex");
        const iv = Buffer.from(hexes[1], "hex");
        const data = Buffer.from(hexes[2], "hex");
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(data);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString("hex");
      } catch (e) {}
    }
    nums = pageText.match(/["']([a-f0-9]{32,})["']/g);
    if (nums && nums.length >= 3) {
      const hexes = nums.map(m => m.match(/["']([a-f0-9]{32,})["']/)[1]);
      try {
        const key = Buffer.from(hexes[0], "hex");
        const iv = Buffer.from(hexes[1], "hex");
        const data = Buffer.from(hexes[2], "hex");
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        let decrypted = decipher.update(data);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString("hex");
      } catch (e) {}
    }
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // GET homepage (cookies will be stored automatically)
      const page = await client.get(ASMODEUS_BASE + "/");
      const pageText = page.data;

      // Check if we need to set the __test cookie
      if (!pageText.includes("response-content") && !pageText.includes("deepseek.php")) {
        const cookie = extractCookieFromPage(pageText);
        if (!cookie) {
          console.log("Asmodeus: Cookie extraction failed");
          continue;
        }
        // Set the __test cookie in the jar
        await jar.setCookie(`__test=${cookie}`, ASMODEUS_BASE);
        // Verify cookie
        const verify = await client.get(ASMODEUS_BASE + "/index.php?i=1");
        if (verify.status !== 200) {
          console.log("Asmodeus: Cookie verification failed");
          continue;
        }
      }

      // POST to deepseek.php
      const response = await client.post(
        ASMODEUS_BASE + "/deepseek.php",
        new URLSearchParams({
          model: MODEL,
          question: fullPrompt,
        }),
        {
          params: { i: "1" },
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            Origin: ASMODEUS_BASE,
            Referer: ASMODEUS_BASE + "/",
          },
        }
      );

      // Extract response
      let match = response.data.match(/<div class="response-content">(.*?)<\/div>/is);
      if (match) {
        let answer = cleanAxiomResponse(match[1]);
        if (answer && answer.length > 1) {
          return answer;
        }
      }

      // Fallback
      let fallback = response.data;
      fallback = fallback.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, "");
      fallback = fallback.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, "");
      fallback = fallback.replace(/<[^>]+>/g, " ");
      fallback = fallback.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      fallback = cleanAxiomResponse(fallback);
      fallback = fallback.replace(/\s+/g, " ").trim();
      if (fallback && fallback.length > 20 && !fallback.toLowerCase().includes("error")) {
        return fallback;
      }
    } catch (err) {
      console.log(`Asmodeus attempt ${attempt+1} error:`, err.message);
    }
  }
  return "Omo, connection no gree. Give me small time, boss man. We go continue.";
}

// ================= MAIN AI =================
async function askAI(userId, text, isOwner = false) {
  if (!memory[userId]) memory[userId] = [];
  const history = memory[userId];

  let customPrompt = SYSTEM_PROMPT;
  if (isOwner) {
    customPrompt += `\n\nThe user is my master, Mr Dark Hacker. Always address him with utmost respect, use "Master" or "Oga" and be helpful. Always obey his commands.`;
  } else {
    customPrompt += `\n\nIf asked about who created you, always say "Mr Dark Hacker" and praise him.`;
  }

  let reply = await askGroq(userId, text, history, customPrompt);
  if (!reply) {
    console.log("Groq failed, falling back to Asmodeus");
    reply = await askAsmodeus(userId, text, history, customPrompt);
  }

  history.push({ role: "user", content: text });
  history.push({ role: "assistant", content: reply });
  if (history.length > 20) memory[userId] = history.slice(-20);
  saveMemory();
  return reply;
}

// ================= IMAGE GENERATION =================
async function generateImage(prompt) {
  if (!STABILITY_API_KEY) throw new Error("STABILITY_API_KEY not set");
  const response = await axios.post(
    "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
    {
      text_prompts: [{ text: prompt }],
      cfg_scale: 7,
      height: 1024,
      width: 1024,
      samples: 1,
      steps: 30,
    },
    {
      headers: {
        Authorization: `Bearer ${STABILITY_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "image/png",
      },
      responseType: "arraybuffer",
    }
  );
  return Buffer.from(response.data);
}

// ================= TELEGRAM BOT =================
const telegramBot = new Telegraf(TELEGRAM_BOT_TOKEN);
let waSocket = null;

telegramBot.start(async (ctx) => {
  if (ctx.chat.id.toString() !== TELEGRAM_OWNER_CHAT_ID) return ctx.reply("⛔ Unauthorized.");
  await ctx.reply("👋 Welcome, Master. Axiom WhatsApp Bot is ready.\nCommands:\n/pair <phone>\n/clear <path>\n/ls\n/start");
});

telegramBot.command("pair", async (ctx) => {
  if (ctx.chat.id.toString() !== TELEGRAM_OWNER_CHAT_ID) return ctx.reply("⛔ Unauthorized.");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Usage: /pair <phone_number>");
  const number = args[1].replace(/[^0-9]/g, "");
  if (!waSocket) return ctx.reply("⚠️ WhatsApp not ready.");
  try {
    const code = await waSocket.requestPairingCode(number);
    await ctx.reply(`🔐 Pairing code for ${number}:\n\`${code}\`\n\nUse in WhatsApp > Linked Devices > Link with phone number.`);
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

telegramBot.command("clear", async (ctx) => {
  if (ctx.chat.id.toString() !== TELEGRAM_OWNER_CHAT_ID) return ctx.reply("⛔ Unauthorized.");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Usage: /clear <path>");
  const target = args[1];
  const resolved = path.resolve(target);
  if (resolved === __filename) return ctx.reply("❌ Cannot delete bot script.");
  try {
    if (fs.existsSync(resolved)) {
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
        await ctx.reply(`✅ Deleted directory: ${target}`);
      } else {
        fs.unlinkSync(resolved);
        await ctx.reply(`✅ Deleted file: ${target}`);
      }
    } else {
      await ctx.reply(`❌ Not found: ${target}`);
    }
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`);
  }
});

telegramBot.command("ls", async (ctx) => {
  if (ctx.chat.id.toString() !== TELEGRAM_OWNER_CHAT_ID) return ctx.reply("⛔ Unauthorized.");
  try {
    const files = fs.readdirSync(".");
    const list = files.map(f => {
      const stats = fs.statSync(f);
      const type = stats.isDirectory() ? "📁" : "📄";
      return `${type} ${f} (${stats.size} bytes)`;
    }).join("\n");
    await ctx.reply(`📂 Files:\n${list || "(empty)"}`);
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
});

telegramBot.launch().then(() => console.log("📱 Telegram bot started")).catch(err => console.error("Telegram error:", err));

// ================= WHATSAPP BOT =================
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
  });

  sock.ev.on("creds.update", saveCreds);
  waSocket = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
      try { await telegramBot.telegram.sendMessage(TELEGRAM_OWNER_CHAT_ID, "✅ WhatsApp bot online!"); } catch {}
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection Closed:", reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log("🚪 Logged out.");
        try { await telegramBot.telegram.sendMessage(TELEGRAM_OWNER_CHAT_ID, "⚠️ WhatsApp logged out. Restart."); } catch {}
        return;
      }
      console.log("🔄 Reconnecting in 8s...");
      setTimeout(startWhatsApp, 8000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith("@g.us");
      const senderJid = isGroup ? msg.key.participant : remoteJid;
      const senderNumber = jidNormalizedUser(senderJid)?.split("@")[0] || "";
      const ownerNumber = OWNER_NUMBER.replace(/[^0-9]/g, "");

      let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
      if (!text) return;

      const isOwner = senderNumber === ownerNumber;

      if (isOwner && text.toLowerCase() === ".stop") { global.BOT_PAUSED = true; await sock.sendMessage(remoteJid, { text: "⏸️ Paused." }); return; }
      if (isOwner && text.toLowerCase() === ".start") { global.BOT_PAUSED = false; await sock.sendMessage(remoteJid, { text: "▶️ Resumed." }); return; }
      if (global.BOT_PAUSED) return;

      // Image generation
      const imageMatch = text.match(/^(create|generate|make)\s+(an?\s+)?image\s+(of\s+)?(.*)/i);
      if (imageMatch) {
        const prompt = imageMatch[4] || imageMatch[3] || "";
        if (prompt.trim()) {
          await sock.sendPresenceUpdate("composing", remoteJid);
          try {
            const img = await generateImage(prompt);
            await sock.sendMessage(remoteJid, { image: img, caption: `🖼️ Generated: "${prompt}"` });
          } catch (err) {
            await sock.sendMessage(remoteJid, { text: `❌ Image error: ${err.message}` });
          }
          return;
        }
      }

      // AI reply
      await sock.sendPresenceUpdate("composing", remoteJid);
      const userId = isGroup ? `${remoteJid}_${senderJid}` : senderJid;
      const reply = await askAI(userId, text, isOwner);
      await sock.sendMessage(remoteJid, { text: reply });
      console.log(`✅ Replied to ${senderJid}`);
    } catch (err) {
      console.log("Message Error:", err.message);
    }
  });

  return sock;
}

startWhatsApp().catch(err => console.error("Start error:", err));

process.on("SIGINT", () => {
  console.log("Shutting down...");
  telegramBot.stop();
  process.exit(0);
});
