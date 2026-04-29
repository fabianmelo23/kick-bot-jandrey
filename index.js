require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const axios = require("axios");

puppeteer.use(StealthPlugin());

const URL = "https://kick.com/jandreytv";
const DATA_FILE = "./data/users.json";
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
const REMOTE_API_URL = process.env.REMOTE_API_URL || "";
const REMOTE_API_TOKEN = process.env.REMOTE_API_TOKEN || "";
const RANKING_URL = process.env.RANKING_URL || (REMOTE_API_URL ? REMOTE_API_URL.replace(/\/+$/, "") : "https://kick-bot-jandrey-3.onrender.com");

const DEFAULT_AVATAR = REMOTE_API_URL
    ? `${REMOTE_API_URL.replace(/\/+$/, "")}/overlay/avatar.png`
    : "http://localhost:3000/overlay/avatar.png";

function defaultStats() {
    return {
        vida: 30,
        fuerza: 2,
        defensa: 2,
        agilidad: 2,
        velocidad: 2
    };
}

let users = {};
let duelCooldown = {};

/* =========================
   DATA
========================= */
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        users = JSON.parse(fs.readFileSync(DATA_FILE));
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

function ensureUser(username) {
    if (!users[username]) {
        users[username] = {
            puntos: 0,
            xp: 0,
            nivel: 1,
            avatar: DEFAULT_AVATAR
        };
        saveData();
    }
}

/* =========================
   RPG
========================= */
function addPoints(username, amount) {

    loadData();
    ensureUser(username);

    let user = users[username];

    user.puntos += amount;
    user.xp += amount;

    let xpNecesaria = user.nivel * 100;

    while (user.xp >= xpNecesaria) {
        user.xp -= xpNecesaria;
        user.nivel += 1;

        console.log(`🆙 ${username} subió a nivel ${user.nivel}`);

        xpNecesaria = user.nivel * 100;
    }

    saveData();

    if (REMOTE_API_URL) {
        axios.post(`${REMOTE_API_URL.replace(/\/+$/, "")}/api/points`, {
            username,
            amount,
            avatar: user.avatar
        }, {
            headers: REMOTE_API_TOKEN ? { "x-api-token": REMOTE_API_TOKEN } : undefined,
            timeout: 8000
        }).catch(() => {});
    }
}

function getRankingTop(limit = 5) {
    loadData();

    const entries = Object.entries(users)
        .map(([username, data]) => ({
            username,
            puntos: Number(data?.puntos ?? 0)
        }))
        .sort((a, b) => b.puntos - a.puntos)
        .slice(0, limit);

    if (entries.length === 0) return "🏅 Ranking vacío por ahora.";

    const top = entries
        .map((u, idx) => `${idx + 1}) ${u.username} (${u.puntos})`)
        .join(" | ");

    return `🏅 Top ${entries.length}: ${top}`;
}

async function getRemoteUser(username) {
    if (!REMOTE_API_URL) return null;
    try {
        const res = await axios.get(`${REMOTE_API_URL.replace(/\/+$/, "")}/user/${encodeURIComponent(username)}`, { timeout: 8000 });
        return res?.data || null;
    } catch {
        return null;
    }
}

/* =========================
   UTIL
========================= */
function getKey(user1, user2) {
    return [user1, user2].sort().join("_");
}

async function sendMessage(page, text) {
    try {
        const input = await page.$('[contenteditable="true"]');
        if (!input) return;

        await input.click();
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");

    } catch {}
}

/* =========================
   DUELO
========================= */
async function duel(page, user1, user2) {

    const now = Date.now();
    const key = getKey(user1, user2);

    if (duelCooldown[key] && now - duelCooldown[key] < COOLDOWN_TIME) {
        return;
    }

    duelCooldown[key] = now;

    ensureUser(user1);
    ensureUser(user2);

    const remote1 = await getRemoteUser(user1);
    const remote2 = await getRemoteUser(user2);

    await axios.post("http://localhost:3000/duelo", {
        jugador1: user1,
        jugador2: user2,
        avatar1: remote1?.avatar || users[user1].avatar || DEFAULT_AVATAR,
        avatar2: remote2?.avatar || users[user2].avatar || DEFAULT_AVATAR,
        nivel1: Number(remote1?.nivel ?? users[user1].nivel ?? 1) || 1,
        nivel2: Number(remote2?.nivel ?? users[user2].nivel ?? 1) || 1,
        stats1: remote1?.stats || defaultStats(),
        stats2: remote2?.stats || defaultStats()
    });

    const ganador = await (async function waitForWinner() {
        const startedAt = Date.now();
        const timeoutMs = 45000;
        const pollEveryMs = 750;

        while (Date.now() - startedAt < timeoutMs) {
            try {
                const res = await axios.get("http://localhost:3000/duelo");
                const g = res?.data?.ganador;
                if (g) return String(g).toLowerCase();
            } catch {}

            await new Promise(r => setTimeout(r, pollEveryMs));
        }

        return null;
    })();

    if (!ganador) return;

    const perdedor = ganador === user1 ? user2 : user1;

    addPoints(ganador, 5);

    await sendMessage(page, `🏆 ${ganador} ganó vs ${perdedor} (+5 pts)`);

    console.log("⚔️ Duelo finalizado:", ganador);
}

/* =========================
   MAIN
========================= */
(async () => {

    console.log("🔥 Iniciando bot...");
    loadData();

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        userDataDir: "C:\\Users\\SantiMichell\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
        args: ["--profile-directory=Default"]
    });

    const page = await browser.newPage();

    await page.goto(URL, { waitUntil: "networkidle2" });

    console.log("⌛ Esperando chat...");
    await new Promise(r => setTimeout(r, 10000)); // 🔥 MÁS TIEMPO

    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    client.on("Network.webSocketFrameReceived", async (event) => {
        try {
            const payload = event.response.payloadData;

            if (!payload.includes("ChatMessageEvent")) return;

            const data = JSON.parse(payload);
            const chat = JSON.parse(data.data);

            const username = chat.sender.username.toLowerCase();
            const message = chat.content.trim().toLowerCase();

            console.log(`💬 ${username}: ${message}`);

            if (message.startsWith("!duelo")) {

                const match = message.match(/@(\w+)/);
                if (!match) return;

                const target = match[1].toLowerCase();
                if (target === username) return;

                await duel(page, username, target);
            }

            if (message === "!ranking") {
                await sendMessage(page, getRankingTop(5));
            }

            if (message === "!jranking") {
                await sendMessage(page, `🏆 Ranking: ${RANKING_URL}`);
            }

        } catch {}
    });

    console.log("✅ Bot listo escuchando chat...");

})();