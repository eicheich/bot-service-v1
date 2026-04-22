const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");
const express = require("express");
require("dotenv").config();
const app = express();

// Konfigurasi limit JSON diperbesar jika file dikirim via base64
app.use(express.json({
    limit: '50mb'
}));

const PORT = process.env.PORT || 3000; // cPanel akan mengisi port ini otomatis
const ENABLE_WHATSAPP = process.env.ENABLE_WHATSAPP === "true";
const WHATSAPP_PROVIDER = (process.env.WHATSAPP_PROVIDER || "baileys").toLowerCase();
const WA_CLOUD_API_VERSION = process.env.WA_CLOUD_API_VERSION || "v23.0";
const WA_CLOUD_TOKEN = process.env.WA_CLOUD_TOKEN;
const WA_CLOUD_PHONE_NUMBER_ID = process.env.WA_CLOUD_PHONE_NUMBER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_INVITE_PERMISSIONS = process.env.DISCORD_INVITE_PERMISSIONS || "274877990912";
const DISCORD_INVITE_SCOPE = process.env.DISCORD_INVITE_SCOPE || "bot applications.commands";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_SERVICE_API_KEY = process.env.BOT_SERVICE_API_KEY;

const crypto = require("crypto");
const telegramConnectTokens = new Map();
const discordConnectTokens = new Map();

// ==========================================
// PANCINGAN CPANEL (WAJIB ADA)
// ==========================================
// cPanel butuh rute ini untuk memastikan aplikasi Node.js tidak crash
app.get("/", (req, res) => {
    res.send("✅ Bot Service (Telegram & Discord) is Running on cPanel!");
});

function normalizeDiscordClaimToken(rawToken) {
    const token = String(rawToken || "").trim();
    if (!token) return "";
    return token.replace(/^token\s*:/i, "").trim();
}

function purgeExpiredDiscordConnectTokens() {
    const now = Date.now();
    for (const [token, record] of discordConnectTokens.entries()) {
        if (!record || record.expiresAt <= now) {
            discordConnectTokens.delete(token);
        }
    }
}

// ==========================================
// ENDPOINT KONEKSI TELEGRAM
// ==========================================

// 1. Generate Link Telegram
app.get("/telegram/connect-link", async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({
        success: false,
        message: "TELEGRAM_BOT_TOKEN belum diset"
    });

    try {
        const state = req.query.state || "";
        const token = req.query.token || crypto.randomUUID().replace(/-/g, "");
        const connectType = String(req.query.type || "group").toLowerCase() === "personal" ? "personal" : "group";

        telegramConnectTokens.set(token, {
            token,
            state,
            status: "pending",
            expiresAt: Date.now() + 900000,
            chat: null,
            claimedFrom: null
        });

        const response = await fetch(getTelegramApiUrl("getMe"));
        const botData = await response.json();
        if (!botData.ok) throw new Error("Gagal mengambil data bot Telegram");

        const botUsername = botData.result.username;
        const personalUrl = `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;
        const groupUrl = `https://t.me/${botUsername}?startgroup=${encodeURIComponent(token)}`;
        const connectUrl = connectType === "personal" ? personalUrl : groupUrl;

        return res.json({
            success: true,
            message: "Link koneksi Telegram berhasil dibuat",
            connect_url: connectUrl,
            url: connectUrl,
            data: {
                token,
                state,
                connect_type: connectType,
                status: "pending"
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// 2. Laravel Check/Claim Status Koneksi
app.post("/telegram/connect/claim", (req, res) => {
    const token = req.body?.token;
    const record = telegramConnectTokens.get(token);

    if (!record) return res.status(404).json({
        success: false,
        message: "Token tidak ditemukan"
    });
    if (record.expiresAt <= Date.now()) {
        telegramConnectTokens.delete(token);
        return res.status(410).json({
            success: false,
            message: "Token kedaluwarsa"
        });
    }
    if (record.status === "pending") {
        return res.status(202).json({
            success: false,
            message: "Belum diklaim user Telegram",
            data: record
        });
    }

    const responseData = {
        token: record.token,
        state: record.state,
        chat: record.chat,
        claimed_from: record.claimedFrom
    };
    telegramConnectTokens.delete(token);

    return res.json({
        success: true,
        message: "Koneksi berhasil diklaim",
        data: responseData
    });
});

// 3. Webhook Telegram
app.post("/telegram/webhook", async (req, res) => {
    res.sendStatus(200);
    const update = req.body;

    try {
        const text = update?.message?.text || "";
        const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
        const chatMemberUpdate = update?.my_chat_member;
        const isGroupJoin = chatMemberUpdate && ["member", "administrator"].includes(chatMemberUpdate.new_chat_member?.status);

        let claimedToken = null;

        if (match && match[1]) {
            claimedToken = match[1];
        } else if (isGroupJoin) {
            const pendingRecords = [...telegramConnectTokens.values()]
                .filter(r => r.status === "pending")
                .sort((a, b) => b.expiresAt - a.expiresAt);
            if (pendingRecords.length > 0) claimedToken = pendingRecords[0].token;
        }

        if (claimedToken) {
            const record = telegramConnectTokens.get(claimedToken);
            if (record && record.status === "pending") {
                const chat = update.message?.chat || update.my_chat_member?.chat;
                const from = update.message?.from || update.my_chat_member?.from;

                record.status = "claimed";
                record.chat = {
                    id: chat.id,
                    type: chat.type,
                    title: chat.title || null,
                    username: chat.username || null
                };
                record.claimedFrom = from ? {
                    id: from.id,
                    username: from.username || null
                } : null;

                await fetch(getTelegramApiUrl("sendMessage"), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        chat_id: chat.id,
                        text: "✅ Koneksi ke Tasku berhasil! Silakan kembali ke website Tasku"
                    })
                });
            }
        }
    } catch (err) {
        console.error("Webhook Telegram Error:", err.message);
    }
});

// --- MIDDLEWARE AUTH ---
if (BOT_SERVICE_API_KEY) {
    app.use((req, res, next) => {
        if (req.path === "/" || req.path === "/health" || req.path === "/status") return next();
        const providedKey = req.header("x-service-key");
        if (providedKey !== BOT_SERVICE_API_KEY) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }
        return next();
    });
}

// --- UTILITIES ---
function normalizePhones(phones) {
    if (!Array.isArray(phones)) return [];
    return [...new Set(phones.map(phone => {
        const digits = String(phone || "").replace(/\D+/g, "");
        if (!digits) return "";
        if (digits.startsWith("0")) return `62${digits.slice(1)}`;
        if (digits.startsWith("8")) return `62${digits}`;
        return digits;
    }).filter(Boolean))];
}

function getTelegramApiUrl(method) {
    return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function callTelegramJson(method, payload) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum diset");
    const response = await fetch(getTelegramApiUrl(method), {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.description || "Gagal Telegram API");
    return data.result;
}

async function resolveTelegramChatName(chatId) {
    try {
        const chat = await callTelegramJson("getChat", {
            chat_id: chatId
        });
        if (!chat || typeof chat !== "object") return null;

        if (chat.type === "group" || chat.type === "supergroup") return chat.title?.toString().trim() || null;
        if (chat.type === "private") {
            const firstName = chat.first_name?.toString().trim();
            if (firstName) return firstName;
            const username = chat.username?.toString().trim();
            return username ? `@${username.replace(/^@+/, "")}` : null;
        }

        if (chat.title) return chat.title?.toString().trim() || null;
        if (chat.first_name) return chat.first_name?.toString().trim() || null;
        if (chat.username) return `@${chat.username.toString().trim().replace(/^@+/, "")}`;
        return null;
    } catch (err) {
        console.error("❌ Gagal resolve nama chat Telegram:", err.message);
        return null;
    }
}

// ==========================================
// 1. TELEGRAM SERVICES
// ==========================================
async function sendTelegramDirect(chatId, message, attachment = null) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum diset");

    if (attachment && attachment.data) {
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("caption", message || attachment.filename || "");
        formData.append("parse_mode", "Markdown");

        const field = attachment.type === "image" ? "photo" : "document";
        const method = attachment.type === "image" ? "sendPhoto" : "sendDocument";

        formData.append(field, new Blob([Buffer.from(attachment.data, "base64")], {
            type: attachment.mime_type || "application/octet-stream",
        }), attachment.filename || "attachment");

        const response = await fetch(getTelegramApiUrl(method), {
            method: "POST",
            body: formData
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.description || "Gagal Telegram API");
        return data;
    }

    const response = await fetch(getTelegramApiUrl("sendMessage"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown"
        }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.description || "Gagal Telegram API");
    return data;
}

// ==========================================
// 2. DISCORD SERVICES
// ==========================================
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
let isDiscordConnected = false;

discordClient.once("clientReady", async () => {
    isDiscordConnected = true;
    console.log(`✅ Discord terhubung: ${discordClient.user.tag}`);

    const clientId = String(DISCORD_CLIENT_ID || discordClient?.user?.id || "").trim();
    if (!clientId) {
        console.warn("⚠️ DISCORD_CLIENT_ID belum diset, slash command /claim tidak didaftarkan");
        return;
    }

    const commands = [
        new SlashCommandBuilder()
        .setName("claim")
        .setDescription("Hubungkan channel ini ke aplikasi")
        .addStringOption((option) =>
            option.setName("token").setDescription("Masukkan token unik dari web").setRequired(true)
        ),
    ].map((command) => command.toJSON());

    const rest = new REST({
        version: "10"
    }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(clientId), {
            body: commands
        });
        console.log("✅ Slash command /claim berhasil didaftarkan");
    } catch (error) {
        console.error("❌ Gagal mendaftarkan slash command /claim:", error.message);
    }
});

discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "claim") return;

    const token = normalizeDiscordClaimToken(interaction.options.getString("token"));
    const record = discordConnectTokens.get(token);

    if (!record) return interaction.reply({
        content: "❌ Token tidak valid atau tidak ditemukan.",
        ephemeral: true
    });
    if (!interaction.guildId) return interaction.reply({
        content: "⚠️ Command ini hanya bisa dipakai di channel server, bukan DM.",
        ephemeral: true
    });
    if (record.expiresAt <= Date.now()) {
        discordConnectTokens.delete(token);
        return interaction.reply({
            content: "⏳ Token sudah kedaluwarsa. Silakan generate ulang dari website.",
            ephemeral: true
        });
    }
    if (record.status === "claimed") return interaction.reply({
        content: "⚠️ Token ini sudah digunakan.",
        ephemeral: true
    });

    record.status = "claimed";
    record.guild = {
        id: String(interaction.guildId),
        name: interaction.guild?.name ? String(interaction.guild.name) : null
    };
    record.channel = {
        id: String(interaction.channelId),
        name: interaction.channel?.name ? String(interaction.channel.name) : null
    };
    record.claimedBy = {
        id: String(interaction.user.id),
        username: interaction.user?.username ? String(interaction.user.username) : null
    };

    await interaction.reply({
        content: `✅ Berhasil! Channel ini sudah terhubung. Token: ${record.token.slice(0, 6)}...`,
        ephemeral: true
    });
});

if (DISCORD_TOKEN) {
    discordClient.login(DISCORD_TOKEN).catch(err => console.error("❌ Gagal login Discord:", err.message));
}

async function sendDiscordDirect(channelId, message, attachment = null) {
    if (!isDiscordConnected) throw new Error("Discord belum terhubung");
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) throw new Error("Channel tidak ditemukan");

    const payload = {
        content: message
    };
    if (attachment && attachment.data) {
        payload.files = [{
            attachment: Buffer.from(attachment.data, "base64"),
            name: attachment.filename || "attachment"
        }];
    }
    return await channel.send(payload);
}

async function resolveDiscordChannelInfo(channelId) {
    if (!isDiscordConnected) throw new Error("Discord belum terhubung");
    const channel = await discordClient.channels.fetch(String(channelId));
    if (!channel || !channel.guildId) return null;
    const guild = channel.guild || await discordClient.guilds.fetch(channel.guildId);

    return {
        guild_id: String(channel.guildId),
        server_name: guild?.name ? String(guild.name) : null,
        channel_id: String(channel.id),
        channel_name: channel?.name ? String(channel.name) : null,
    };
}

function getDiscordInviteLink() {
    const fallbackClientId = discordClient?.user?.id ? String(discordClient.user.id) : "";
    const clientId = String(DISCORD_CLIENT_ID || fallbackClientId).trim();
    if (!clientId) return null;

    const params = new URLSearchParams({
        client_id: clientId,
        scope: DISCORD_INVITE_SCOPE,
        permissions: String(DISCORD_INVITE_PERMISSIONS),
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

// ==========================================
// 3. WHATSAPP SERVICES (Dilewati Sementara)
// ==========================================
async function connectWhatsApp() {
    // Fungsi ini sengaja dikosongkan/dimatikan pemanggilannya di bawah
    // agar cPanel tidak crash karena background process Baileys
}

// ==========================================
// 4. API ENDPOINTS
// ==========================================

app.get("/telegram/chat/:chatId", async (req, res) => {
    const chatId = req.params.chatId;
    if (!chatId) return res.json({
        name: null
    });
    const name = await resolveTelegramChatName(chatId);
    return res.json({
        name: name || null
    });
});

app.post("/telegram/send", async (req, res) => {
    try {
        const {
            chat_id,
            message,
            file
        } = req.body;
        if (!chat_id) return res.status(400).json({
            success: false,
            message: "chat_id wajib"
        });
        const result = await sendTelegramDirect(chat_id, message, file);
        return res.json({
            success: true,
            message: "Pesan Telegram terkirim!",
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.get("/discord/invite-link", (req, res) => {
    const inviteLink = getDiscordInviteLink();
    const clientId = String(DISCORD_CLIENT_ID || discordClient?.user?.id || "").trim() || null;

    if (!inviteLink) {
        return res.status(503).json({
            success: false,
            message: "DISCORD_CLIENT_ID belum diset",
            invite_link: null,
            data: {
                invite_link: null,
                client_id: null,
                scope: DISCORD_INVITE_SCOPE,
                permissions: String(DISCORD_INVITE_PERMISSIONS)
            }
        });
    }

    return res.json({
        success: true,
        message: "Link invite Discord berhasil dibuat",
        invite_link: inviteLink,
        data: {
            invite_link: inviteLink,
            client_id: clientId,
            scope: DISCORD_INVITE_SCOPE,
            permissions: String(DISCORD_INVITE_PERMISSIONS)
        }
    });
});

app.get("/discord/connect-link", (req, res) => {
    purgeExpiredDiscordConnectTokens();
    const state = String(req.query?.state || "").trim();
    const token = crypto.randomUUID().replace(/-/g, "");

    discordConnectTokens.set(token, {
        token,
        state,
        status: "pending",
        expiresAt: Date.now() + 900000,
        guild: null,
        channel: null,
        claimedBy: null
    });

    return res.json({
        success: true,
        message: "Token koneksi Discord berhasil dibuat",
        data: {
            token,
            state,
            command: `/claim token:${token}`,
            status: "pending",
            expires_at: new Date(Date.now() + 900000).toISOString()
        }
    });
});

app.post("/discord/connect/claim", (req, res) => {
    const token = normalizeDiscordClaimToken(req.body?.token);
    const record = discordConnectTokens.get(token);

    if (!record) return res.status(404).json({
        success: false,
        message: "Token tidak ditemukan"
    });
    if (record.expiresAt <= Date.now()) {
        discordConnectTokens.delete(token);
        return res.status(410).json({
            success: false,
            message: "Token kedaluwarsa"
        });
    }
    if (record.status === "pending") return res.status(202).json({
        success: false,
        message: "Belum diklaim di Discord",
        data: record
    });

    const responseData = {
        token: record.token,
        state: record.state,
        guild: record.guild,
        channel: record.channel,
        claimed_by: record.claimedBy
    };
    discordConnectTokens.delete(token);

    return res.json({
        success: true,
        message: "Koneksi Discord berhasil diklaim",
        data: responseData
    });
});

app.get("/discord/channel/:channelId", async (req, res) => {
    try {
        const channelId = String(req.params.channelId || "").trim();
        if (!channelId) return res.status(400).json({
            success: false,
            message: "channelId wajib"
        });

        const data = await resolveDiscordChannelInfo(channelId);
        if (!data) return res.status(404).json({
            success: false,
            message: "Channel tidak ditemukan",
            data: null
        });

        return res.json({
            success: true,
            data
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.post("/discord/send", async (req, res) => {
    try {
        const {
            channel_id,
            message,
            file
        } = req.body;
        if (!channel_id) return res.status(400).json({
            success: false,
            message: "channel_id wajib"
        });
        const result = await sendDiscordDirect(channel_id, message, file);
        return res.json({
            success: true,
            message: "Pesan Discord terkirim!",
            id: result.id
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.get("/health", (req, res) => res.json({
    success: true,
    status: "OK",
    port: PORT
}));

app.listen(PORT, () => {
    console.log(`🚀 Kurir API berjalan di port ${PORT}`);
    // connectWhatsApp(); // DIBUAT COMMENT SEMENTARA AGAR WA TIDAK JALAN DI CPANEL
});
