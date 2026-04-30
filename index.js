require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

puppeteer.use(StealthPlugin());

const URL = "https://kick.com/jandreytv";
/** Misma ruta que server.js; si no, el bot lee otro users.json según la carpeta desde la que arranques node. */
const DATA_FILE = path.join(__dirname, "data", "users.json");

function panelCacheQuery() {
    try {
        const st = fs.statSync(path.join(__dirname, "panel", "index.html"));
        return `p=${st.mtimeMs}`;
    } catch {
        return `p=${Date.now()}`;
    }
}
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;
const REMOTE_API_URL = process.env.REMOTE_API_URL || "";
const REMOTE_API_TOKEN = process.env.REMOTE_API_TOKEN || "";
/** Puerto del Express donde corre el panel (mismo que server.js PORT). */
const LOCAL_USER_PORT = process.env.LOCAL_USER_PORT || "3000";

function localApiBases() {
    const custom = process.env.LOCAL_USER_API && String(process.env.LOCAL_USER_API).trim();
    if (custom) return [custom.replace(/\/+$/, "")];
    return [
        `http://127.0.0.1:${LOCAL_USER_PORT}`,
        `http://localhost:${LOCAL_USER_PORT}`
    ];
}

function getDuelServerOrigin() {
    const d = process.env.DUEL_SERVER_URL && String(process.env.DUEL_SERVER_URL).trim();
    if (d) return d.replace(/\/+$/, "");
    return localApiBases()[0];
}
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

/**
 * Al guardar, el panel (server.js) y el bot pisan el mismo users.json.
 * Las stats las sube solo el panel (+); el duelo solo puntos/xp. Sin esto,
 * saveData del bot podía volver a escribir vida 30 y borrar el 31 del panel.
 */
function mergeUserForSave(diskRow, memRow) {
    const d = diskRow && typeof diskRow === "object" ? diskRow : {};
    const m = memRow && typeof memRow === "object" ? memRow : {};
    const out = { ...d, ...m };
    const defs = defaultStats();
    out.stats = { ...defs };
    for (const k of Object.keys(defs)) {
        const a = Number(d.stats?.[k]);
        const b = Number(m.stats?.[k]);
        const vals = [defs[k]];
        if (Number.isFinite(a)) vals.push(a);
        if (Number.isFinite(b)) vals.push(b);
        out.stats[k] = Math.max(...vals);
    }
    return out;
}

/** Igual que en server: todo usuario debe tener stats; si falta, no podemos fusionar bien con el panel. */
function ensureStatsLocal(user) {
    if (!user || typeof user !== "object") return;
    if (!user.stats || typeof user.stats !== "object") {
        user.stats = defaultStats();
        return;
    }
    const defs = defaultStats();
    for (const k of Object.keys(defs)) {
        const v = Number(user.stats[k]);
        user.stats[k] = Number.isFinite(v) ? v : defs[k];
    }
}

let users = {};
let duelCooldown = {};

/* =========================
   DATA
========================= */
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        users = JSON.parse(fs.readFileSync(DATA_FILE));
        for (const un of Object.keys(users)) {
            ensureStatsLocal(users[un]);
        }
    }
}

function saveData() {
    let diskFresh = {};
    if (fs.existsSync(DATA_FILE)) {
        try {
            diskFresh = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        } catch {}
    }
    const out = { ...diskFresh };
    for (const un of Object.keys(users)) {
        out[un] = mergeUserForSave(diskFresh[un], users[un]);
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
    for (const un of Object.keys(users)) {
        if (out[un]) users[un] = out[un];
    }
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
            puntosEstadistica: 0,
            stats: defaultStats()
        };
        saveData();
        return;
    }
    const u = users[username];
    if (u.habilidadProgreso === undefined) u.habilidadProgreso = 0;
    if (u.puntosEstadistica === undefined) u.puntosEstadistica = 0;
    ensureStatsLocal(u);
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

/**
 * Stats para el overlay: GET /user en Express local primero (ahí guarda el panel), luego Render,
 * más el archivo del bot. Por stat usa el máximo entre fuentes.
 */
async function fetchDuelPlayer(username) {
    const u = String(username || "").toLowerCase();
    loadData();
    ensureUser(u);
    const localRow = users[u] || {};

    const fromApi = [];
    for (const base of localApiBases()) {
        try {
            const res = await axios.get(`${base}/user/${encodeURIComponent(u)}`, { timeout: 5000 });
            if (res?.data && typeof res.data === "object") {
                fromApi.push(res.data);
                break;
            }
        } catch {}
    }
    if (REMOTE_API_URL) {
        try {
            const res = await axios.get(
                `${REMOTE_API_URL.replace(/\/+$/, "")}/user/${encodeURIComponent(u)}`,
                { timeout: 8000 }
            );
            if (res?.data && typeof res.data === "object") fromApi.push(res.data);
        } catch {}
    }

    const defaults = defaultStats();
    const stats = { ...defaults };
    for (const key of Object.keys(defaults)) {
        const vals = [Number(defaults[key])];
        if (localRow.stats && Number.isFinite(Number(localRow.stats[key]))) {
            vals.push(Number(localRow.stats[key]));
        }
        for (const row of fromApi) {
            if (row.stats && Number.isFinite(Number(row.stats[key]))) {
                vals.push(Number(row.stats[key]));
            }
        }
        stats[key] = Math.max(...vals);
    }

    let nivel = Number(localRow.nivel) || 1;
    let avatar = localRow.avatar || DEFAULT_AVATAR;
    for (const row of fromApi) {
        const n = Number(row.nivel);
        if (Number.isFinite(n) && n > nivel) nivel = n;
        if (row.avatar && String(row.avatar).trim()) avatar = row.avatar;
    }

    return { avatar, nivel, stats };
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

    const p1 = await fetchDuelPlayer(user1);
    const p2 = await fetchDuelPlayer(user2);
    const seed = Date.now();

    await axios.post(`${getDuelServerOrigin()}/duelo`, {
        jugador1: user1,
        jugador2: user2,
        avatar1: p1.avatar,
        avatar2: p2.avatar,
        nivel1: p1.nivel,
        nivel2: p2.nivel,
        stats1: p1.stats,
        stats2: p2.stats,
        seed
    });

    const ganador = await (async function waitForWinner() {
        const startedAt = Date.now();
        const timeoutMs = 45000;
        const pollEveryMs = 750;

        while (Date.now() - startedAt < timeoutMs) {
            try {
                const res = await axios.get(`${getDuelServerOrigin()}/duelo`);
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

    await sendMessage(page, `🏆 ${ganador} (+5) ganó vs ${perdedor} (-1)`);

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
                const pq = panelCacheQuery();
                await sendMessage(page, `👤 Perfil: ${PROFILE_URL}/panel/?user=${encodeURIComponent(username)}&${pq}`);
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