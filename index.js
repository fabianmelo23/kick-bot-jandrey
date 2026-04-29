require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

puppeteer.use(StealthPlugin());

const URL = "https://kick.com/jandreytv";
const DATA_FILE = "./data/users.json";
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
const REMOTE_API_URL = process.env.REMOTE_API_URL || "";
const REMOTE_API_TOKEN = process.env.REMOTE_API_TOKEN || "";
const RANKING_URL = process.env.RANKING_URL || (REMOTE_API_URL ? REMOTE_API_URL.replace(/\/+$/, "") : "https://kick-bot-jandrey-3.onrender.com");
const PROFILE_URL = process.env.PROFILE_URL || (REMOTE_API_URL ? REMOTE_API_URL.replace(/\/+$/, "") : "https://kick-bot-jandrey-3.onrender.com");

const DEFAULT_AVATAR = REMOTE_API_URL
    ? `${REMOTE_API_URL.replace(/\/+$/, "")}/overlay/avatar.png`
    : "http://localhost:3000/overlay/avatar.png";

const BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const BROWSER_USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || path.join(__dirname, "perfil-bot");
const BROWSER_PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || "Default";
const BROWSER_CONNECT_URL = process.env.BROWSER_CONNECT_URL || "";

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

function ensureHabilidadLocal(user) {
    let h = Number(user.habilidadProgreso);
    if (!Number.isFinite(h) || h < 0) h = 0;
    let pe = Number(user.puntosEstadistica);
    if (!Number.isFinite(pe) || pe < 0) pe = 0;
    while (h >= 50) {
        h -= 50;
        pe += 1;
    }
    user.habilidadProgreso = h;
    user.puntosEstadistica = pe;
}

function ensureUser(username) {
    if (!users[username]) {
        users[username] = {
            puntos: 0,
            xp: 0,
            nivel: 1,
            avatar: DEFAULT_AVATAR,
            habilidadProgreso: 0,
            puntosEstadistica: 0
        };
        saveData();
        return;
    }
    const u = users[username];
    if (u.habilidadProgreso === undefined) u.habilidadProgreso = 0;
    if (u.puntosEstadistica === undefined) u.puntosEstadistica = 0;
    ensureHabilidadLocal(u);
}

/* =========================
   RPG
========================= */
function addPoints(username, amount, applyXp = true) {

    loadData();
    ensureUser(username);

    let user = users[username];

    user.puntos = Math.max(0, Number(user.puntos || 0) + amount);

    if (applyXp) {
        user.xp += amount;

        let xpNecesaria = user.nivel * 100;

        while (user.xp >= xpNecesaria) {
            user.xp -= xpNecesaria;
            user.nivel += 1;

            console.log(`🆙 ${username} subió a nivel ${user.nivel}`);

            xpNecesaria = user.nivel * 100;
        }
    }

    saveData();

    if (REMOTE_API_URL) {
        axios.post(`${REMOTE_API_URL.replace(/\/+$/, "")}/api/points`, {
            username,
            amount,
            applyXp,
            avatar: user.avatar
        }, {
            headers: REMOTE_API_TOKEN ? { "x-api-token": REMOTE_API_TOKEN } : undefined,
            timeout: 8000
        }).catch(() => {});
    }
}

/** @returns {number} puntos de stat ganados en este duelo (0 si solo subió la barra) */
function addHabilidadDuelWin(username) {
    loadData();
    ensureUser(username);
    const u = users[username];
    const bankBefore = Math.max(0, Number(u.puntosEstadistica) || 0);
    u.habilidadProgreso = (Number(u.habilidadProgreso) || 0) + 1;
    u.puntosEstadistica = bankBefore;
    while (u.habilidadProgreso >= 50) {
        u.habilidadProgreso -= 50;
        u.puntosEstadistica += 1;
    }
    const statPointsGained = u.puntosEstadistica - bankBefore;
    saveData();

    if (REMOTE_API_URL) {
        axios.post(`${REMOTE_API_URL.replace(/\/+$/, "")}/api/duel/habilidad-win`, {
            username
        }, {
            headers: REMOTE_API_TOKEN ? { "x-api-token": REMOTE_API_TOKEN } : undefined,
            timeout: 8000
        }).catch(() => {});
    }

    return statPointsGained;
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
    // Cooldown should be directional: challenger -> target
    // This allows the target to immediately challenge back.
    return `${user1}__${user2}`;
}

async function sendMessage(page, text) {
    try {
        if (!text) return;

        // sanitize to avoid weird control chars / newlines
        const safeText = String(text)
            .replace(/[\r\n\t]+/g, " ")
            .replace(/[\u0000-\u001F\u007F]/g, "")
            .trim()
            .slice(0, 220);

        if (!safeText) return;

        const input = await page.waitForSelector('[contenteditable="true"]', { timeout: 7000 });
        if (!input) return;

        // Focus + clear existing content (prevents first-send garbage)
        await input.evaluate(el => {
            el.focus();
            // Clear contenteditable safely
            el.innerText = "";
        });

        // Use CDP input so it works even if Brave isn't focused
        const client = await page.target().createCDPSession();
        await client.send("Input.insertText", { text: safeText });
        await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

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
    const seed = Date.now();

    await axios.post("http://localhost:3000/duelo", {
        jugador1: user1,
        jugador2: user2,
        avatar1: remote1?.avatar || users[user1].avatar || DEFAULT_AVATAR,
        avatar2: remote2?.avatar || users[user2].avatar || DEFAULT_AVATAR,
        nivel1: Number(remote1?.nivel ?? users[user1].nivel ?? 1) || 1,
        nivel2: Number(remote2?.nivel ?? users[user2].nivel ?? 1) || 1,
        stats1: remote1?.stats || defaultStats(),
        stats2: remote2?.stats || defaultStats(),
        seed
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
    addPoints(perdedor, -1, false);
    const statGanados = addHabilidadDuelWin(ganador);

    await sendMessage(page, `🏆 ${ganador} ganó vs ${perdedor} (+5 / -1 pts)`);

    if (statGanados > 0) {
        const extra =
            statGanados === 1
                ? `⭐ ${ganador}: ¡punto de stat disponible! Entra al panel de perfil y pulsa + en la stat que quieras subir.`
                : `⭐ ${ganador}: ¡${statGanados} puntos de stat disponibles! Panel de perfil → + en cada estadística.`;
        await sendMessage(page, extra);
    }

    console.log("⚔️ Duelo finalizado:", ganador);
}

/* =========================
   MAIN
========================= */
(async () => {

    console.log("🔥 Iniciando bot...");
    loadData();

    const browser = BROWSER_CONNECT_URL
        ? await puppeteer.connect({ browserURL: BROWSER_CONNECT_URL })
        : await puppeteer.launch({
            headless: false,
            executablePath: BROWSER_EXECUTABLE_PATH,
            userDataDir: BROWSER_USER_DATA_DIR,
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                `--profile-directory=${BROWSER_PROFILE_DIR}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-blink-features=AutomationControlled"
            ]
        });

    browser.on("disconnected", () => {
        console.log("⚠️ Navegador desconectado. Si usas remote debugging, no cierres Brave.");
    });

    const page = await browser.newPage();
    try {
        const ua = await browser.userAgent();
        await page.setUserAgent(ua.replace("HeadlessChrome", "Chrome"));
    } catch {}

    await page.goto(URL, { waitUntil: "networkidle2" });

    console.log("⌛ Esperando chat...");
    await new Promise(r => setTimeout(r, 10000)); // 🔥 MÁS TIEMPO

    const client = await page.target().createCDPSession();
    await client.send("Network.enable");

    let lastChatMs = Date.now();
    const heartbeat = setInterval(() => {
        const secs = Math.floor((Date.now() - lastChatMs) / 1000);
        if (secs >= 30) {
            console.log(`⏳ Sin mensajes capturados aún (${secs}s).`);
        }
    }, 30000);

    client.on("Network.webSocketFrameReceived", async (event) => {
        try {
            const payload = event.response.payloadData;

            if (!payload.includes("ChatMessageEvent")) return;

            const data = JSON.parse(payload);
            const chat = JSON.parse(data.data);

            const username = chat.sender.username.toLowerCase();
            const message = chat.content.trim().toLowerCase();

            console.log(`💬 ${username}: ${message}`);
            lastChatMs = Date.now();

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

            if (message === "!jprofile") {
                await sendMessage(page, `👤 Perfil: ${PROFILE_URL}/panel/?user=${encodeURIComponent(username)}`);
            }

            if (message.startsWith("!verify")) {
                const parts = message.split(/\s+/);
                // expected: !verify <username> <code>
                const requestedUsername = parts[1];
                const code = parts[2];
                if (!requestedUsername || !code) return;

                if (REMOTE_API_URL) {
                    axios.post(`${REMOTE_API_URL.replace(/\/+$/, "")}/api/auth/verify`, {
                        sender: username,
                        username: requestedUsername,
                        code
                    }, {
                        headers: REMOTE_API_TOKEN ? { "x-bot-token": REMOTE_API_TOKEN } : undefined,
                        timeout: 8000
                    }).then((r) => {
                        if (r?.data?.ok) {
                            sendMessage(page, `✅ ${requestedUsername} verificado. Ya puedes abrir tu perfil.`);
                        }
                    }).catch(() => {});
                }
            }

        } catch {}
    });

    console.log("✅ Bot listo escuchando chat...");

    // Keep the process alive even if the browser connection drops.
    await new Promise(() => {});

})();