require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || null;
const AUTH_BOT_TOKEN = process.env.AUTH_BOT_TOKEN || API_TOKEN || null;

app.use(express.json());

/* =========================
   AUTH (chat verify)
========================= */
const SESSION_COOKIE = "kick_profile_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERIFY_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory stores (Render instances may restart; user can re-verify)
const pendingById = new Map(); // id -> { username, code, expiresAt, verified }
const pendingByCode = new Map(); // code -> id
const sessions = new Map(); // token -> { username, expiresAt }

function nowMs() { return Date.now(); }

function randomCode() {
    // 6 digits
    return String(Math.floor(100000 + Math.random() * 900000));
}

function randomToken() {
    // short safe token
    return `${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    const out = {};
    for (const part of header.split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (!k) continue;
        out[k] = decodeURIComponent(rest.join("=") || "");
    }
    return out;
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    // HttpOnly cookie; SameSite Lax so normal navigation works
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}

function getSession(req) {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (nowMs() > s.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return { token, ...s };
}

function requireUserSession(req, res, next) {
    const username = String(req.params.username || "").toLowerCase();
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: "No autenticado" });
    if (s.username !== username) return res.status(403).json({ error: "No autorizado" });
    next();
}

function requireBotToken(req, res, next) {
    if (!AUTH_BOT_TOKEN) return res.status(500).json({ error: "AUTH_BOT_TOKEN no configurado" });
    const token = req.header("x-bot-token");
    if (!token || token !== AUTH_BOT_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    next();
}

/* =========================
   USERS
========================= */
const filePath = path.join(__dirname, "data", "users.json");

function readUsers() {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
}

function defaultStats() {
    return {
        vida: 30,
        fuerza: 2,
        defensa: 2,
        agilidad: 2,
        velocidad: 2
    };
}

const STAT_KEYS = Object.keys(defaultStats());

function defaultInventory() {
    return {
        // Se llena/actualiza desde el catálogo para que todos vean las skins del panel.
        skins: ["default"],
        armas: [],
        mascotas: []
    };
}

function getSkinsCatalog() {
    try {
        const catalogPath = path.join(__dirname, "panel", "skins.json");
        if (!fs.existsSync(catalogPath)) return { skins: [{ id: "default" }] };
        const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        if (!parsed || !Array.isArray(parsed.skins)) return { skins: [{ id: "default" }] };
        return parsed;
    } catch {
        return { skins: [{ id: "default" }] };
    }
}

function getCatalogSkinIds() {
    const catalog = getSkinsCatalog();
    const ids = catalog.skins
        .map(s => String(s?.id || "").trim())
        .filter(Boolean);
    return ids.length ? Array.from(new Set(ids)) : ["default"];
}

function defaultAvatarUrl() {
    // Prefer PNG if present (user-provided), fallback to SVG.
    const pngPath = path.join(__dirname, "overlay", "avatar.png");
    return fs.existsSync(pngPath) ? "/overlay/avatar.png" : "/overlay/avatar.svg";
}

function skinToAvatarUrl(skinId) {
    // Minimal catalog mapping. Keep URLs relative so it works on Render and local.
    const id = String(skinId || "default").trim() || "default";
    if (id === "default") return defaultAvatarUrl();

    // Convention: store skins at /overlay/skins/<id>.png
    const filePath = path.join(__dirname, "overlay", "skins", `${id}.png`);
    if (fs.existsSync(filePath)) return `/overlay/skins/${id}.png`;

    // Fallback if missing
    return defaultAvatarUrl();
}

function ensureStats(user) {
    if (!user.stats || typeof user.stats !== "object") {
        user.stats = defaultStats();
        return;
    }

    const defaults = defaultStats();
    for (const k of Object.keys(defaults)) {
        const v = Number(user.stats[k]);
        user.stats[k] = Number.isFinite(v) ? v : defaults[k];
    }
}

function ensureInventory(user) {
    const defaults = defaultInventory();
    const catalogIds = getCatalogSkinIds();
    if (!user.inventory || typeof user.inventory !== "object") {
        user.inventory = defaults;
    } else {
        if (!Array.isArray(user.inventory.skins)) user.inventory.skins = defaults.skins;
        if (!Array.isArray(user.inventory.armas)) user.inventory.armas = defaults.armas;
        if (!Array.isArray(user.inventory.mascotas)) user.inventory.mascotas = defaults.mascotas;
    }

    // Make catalog skins available by default (free skins).
    for (const id of catalogIds) {
        if (!user.inventory.skins.includes(id)) user.inventory.skins.push(id);
    }

    if (!user.selectedSkin || typeof user.selectedSkin !== "string") {
        user.selectedSkin = "default";
    }

    // Ensure selected skin is owned; fallback to default.
    if (!user.inventory.skins.includes(user.selectedSkin)) {
        user.selectedSkin = "default";
    }

    // Keep avatar aligned with selected skin unless a custom absolute URL is used later.
    const mappedAvatar = skinToAvatarUrl(user.selectedSkin);
    const currentAvatar = typeof user.avatar === "string" ? user.avatar.trim() : "";
    if (
        !currentAvatar ||
        currentAvatar.includes("localhost:3000") ||
        currentAvatar === "/overlay/avatar.png"
    ) {
        user.avatar = mappedAvatar;
    }
}

function ensureHabilidad(user) {
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

function applyHabilidadDuelWin(users, username) {
    ensureUser(users, username);
    const u = users[username];
    u.habilidadProgreso = (Number(u.habilidadProgreso) || 0) + 1;
    u.puntosEstadistica = Math.max(0, Number(u.puntosEstadistica) || 0);
    while (u.habilidadProgreso >= 50) {
        u.habilidadProgreso -= 50;
        u.puntosEstadistica += 1;
    }
}

function publicProfileUser(u, username) {
    ensureHabilidad(u);
    return {
        username,
        puntos: u.puntos,
        xp: u.xp,
        nivel: u.nivel,
        avatar: u.avatar,
        stats: u.stats,
        selectedSkin: u.selectedSkin,
        inventory: u.inventory,
        habilidadProgreso: Number(u.habilidadProgreso) || 0,
        puntosEstadistica: Math.max(0, Number(u.puntosEstadistica) || 0)
    };
}

function ensureUser(users, username) {
    if (!users[username]) {
        users[username] = {
            puntos: 0,
            xp: 0,
            nivel: 1,
            avatar: skinToAvatarUrl("default"),
            stats: defaultStats(),
            inventory: defaultInventory(),
            selectedSkin: "default",
            habilidadProgreso: 0,
            puntosEstadistica: 0
        };
        return;
    }

    // migrate old users
    ensureStats(users[username]);
    ensureInventory(users[username]);
    ensureHabilidad(users[username]);
}

function addPointsToUser(users, username, amount, applyXp = true) {
    ensureUser(users, username);
    const user = users[username];

    const delta = Number(amount) || 0;
    user.puntos = Math.max(0, Number(user.puntos || 0) + delta);

    if (!applyXp) return;

    user.xp = Number(user.xp || 0) + delta;

    let xpNecesaria = Number(user.nivel || 1) * 100;
    while (user.xp >= xpNecesaria) {
        user.xp -= xpNecesaria;
        user.nivel = Number(user.nivel || 1) + 1;
        xpNecesaria = Number(user.nivel || 1) * 100;
    }
}

function requireToken(req, res, next) {
    if (!API_TOKEN) return next(); // allow if not configured
    const token = req.header("x-api-token");
    if (!token || token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    next();
}

function sanitizeAvatar(avatar) {
    if (typeof avatar !== "string") return null;
    const v = avatar.trim();
    if (!v) return null;
    if (v.includes("localhost:3000")) return defaultAvatarUrl();
    return v;
}

function clamp(min, value, max) {
    return Math.max(min, Math.min(max, value));
}

function sanitizeStats(stats, currentStats) {
    const defaults = defaultStats();
    const base = currentStats && typeof currentStats === "object" ? currentStats : defaults;
    const s = (stats && typeof stats === "object") ? stats : {};

    const vida = clamp(1, Number(s.vida ?? base.vida ?? defaults.vida), 999);
    const fuerza = clamp(0, Number(s.fuerza ?? base.fuerza ?? defaults.fuerza), 99);
    const defensa = clamp(0, Number(s.defensa ?? base.defensa ?? defaults.defensa), 99);
    const agilidad = clamp(0, Number(s.agilidad ?? base.agilidad ?? defaults.agilidad), 99);
    const velocidad = clamp(0, Number(s.velocidad ?? base.velocidad ?? defaults.velocidad), 99);

    return {
        vida: Number.isFinite(vida) ? vida : defaults.vida,
        fuerza: Number.isFinite(fuerza) ? fuerza : defaults.fuerza,
        defensa: Number.isFinite(defensa) ? defensa : defaults.defensa,
        agilidad: Number.isFinite(agilidad) ? agilidad : defaults.agilidad,
        velocidad: Number.isFinite(velocidad) ? velocidad : defaults.velocidad
    };
}

/* =========================
   STATIC
========================= */
app.use("/overlay", express.static(path.join(__dirname, "overlay")));
app.use("/panel", express.static(path.join(__dirname, "panel")));
app.use("/ranking", express.static(path.join(__dirname, "ranking")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "ranking", "index.html"));
});

app.get("/health", (req, res) => {
    res.send("🔥 Server activo");
});

/* =========================
   AUTH API
========================= */
app.get("/api/me", (req, res) => {
    const s = getSession(req);
    if (!s) return res.json({ loggedIn: false });
    return res.json({ loggedIn: true, username: s.username });
});

app.post("/api/auth/start", (req, res) => {
    const username = String(req.body?.username || "").toLowerCase().trim();
    if (!username) return res.status(400).json({ error: "username requerido" });

    const id = randomToken();
    const code = randomCode();
    const expiresAt = nowMs() + VERIFY_TTL_MS;

    pendingById.set(id, { username, code, expiresAt, verified: false });
    pendingByCode.set(code, id);

    return res.json({ id, code, expiresAt, command: `!verify ${username} ${code}` });
});

app.get("/api/auth/status/:id", (req, res) => {
    const id = String(req.params.id || "");
    const p = pendingById.get(id);
    if (!p) return res.status(404).json({ error: "No existe" });
    if (nowMs() > p.expiresAt) return res.status(410).json({ error: "Expirado" });
    return res.json({ verified: Boolean(p.verified), username: p.username });
});

app.post("/api/auth/complete/:id", (req, res) => {
    const id = String(req.params.id || "");
    const p = pendingById.get(id);
    if (!p) return res.status(404).json({ error: "No existe" });
    if (nowMs() > p.expiresAt) return res.status(410).json({ error: "Expirado" });
    if (!p.verified) return res.status(400).json({ error: "Aún no verificado" });

    const token = randomToken();
    sessions.set(token, { username: p.username, expiresAt: nowMs() + SESSION_TTL_MS });
    setSessionCookie(res, token);

    // cleanup
    pendingById.delete(id);
    pendingByCode.delete(p.code);

    return res.json({ ok: true, username: p.username });
});

// Called by the bot after seeing `!verify <code>` from Kick chat.
app.post("/api/auth/verify", requireBotToken, (req, res) => {
    const sender = String(req.body?.sender || "").toLowerCase().trim();
    const requestedUsername = String(req.body?.username || "").toLowerCase().trim();
    const code = String(req.body?.code || "").trim();
    if (!sender || !requestedUsername || !code) return res.status(400).json({ error: "sender, username y code requeridos" });

    const id = pendingByCode.get(code);
    if (!id) return res.status(404).json({ error: "Código inválido" });
    const p = pendingById.get(id);
    if (!p) return res.status(404).json({ error: "Código inválido" });
    if (nowMs() > p.expiresAt) return res.status(410).json({ error: "Código expirado" });
    if (p.username !== requestedUsername) return res.status(403).json({ error: "Código no corresponde a este usuario" });
    if (sender !== requestedUsername) return res.status(403).json({ error: "El sender no coincide con el usuario" });

    p.verified = true;
    pendingById.set(id, p);

    return res.json({ ok: true });
});

/* =========================
   USERS API
========================= */
app.get("/users", (req, res) => {
    res.json(readUsers());
});

app.get("/user/:username", (req, res) => {
    const users = readUsers();
    const user = req.params.username.toLowerCase();

    ensureUser(users, user);
    saveUsers(users);

    res.json(users[user]);
});

/* =========================
   PROFILE API
========================= */
app.get("/api/profile/:username", requireUserSession, (req, res) => {
    const users = readUsers();
    const username = req.params.username.toLowerCase();

    ensureUser(users, username);
    saveUsers(users);

    const u = users[username];
    return res.json(publicProfileUser(u, username));
});

app.post("/api/profile/:username", requireToken, requireUserSession, (req, res) => {
    const users = readUsers();
    const username = req.params.username.toLowerCase();

    ensureUser(users, username);

    const u = users[username];

    // selected skin
    let selectedSkin = u.selectedSkin;
    if (typeof req.body?.selectedSkin === "string") {
        selectedSkin = req.body.selectedSkin.trim();
    }

    const catalogIds = getCatalogSkinIds();
    if (!catalogIds.includes(selectedSkin)) {
        return res.status(400).json({ error: "selectedSkin no existe en el catálogo" });
    }

    // stats
    const nextStats = sanitizeStats(req.body?.stats, u.stats);

    u.selectedSkin = selectedSkin;
    u.stats = nextStats;
    u.avatar = skinToAvatarUrl(selectedSkin);

    saveUsers(users);

    return res.json({
        ok: true,
        user: publicProfileUser(u, username)
    });
});

app.post("/api/profile/:username/spend-stat", requireUserSession, (req, res) => {
    const users = readUsers();
    const username = req.params.username.toLowerCase();
    const stat = String(req.body?.stat || "").toLowerCase().trim();

    ensureUser(users, username);
    const u = users[username];

    if (!STAT_KEYS.includes(stat)) return res.status(400).json({ error: "stat inválida" });

    const bank = Math.max(0, Number(u.puntosEstadistica) || 0);
    if (bank < 1) return res.status(400).json({ error: "No tienes puntos para gastar" });

    ensureStats(u);
    u.puntosEstadistica = bank - 1;
    u.stats[stat] = Number(u.stats[stat] || 0) + 1;

    saveUsers(users);

    return res.json({ ok: true, user: publicProfileUser(u, username) });
});

// Public: allow selecting a skin without token (stats remain protected)
app.post("/api/profile/:username/skin", requireUserSession, (req, res) => {
    const users = readUsers();
    const username = req.params.username.toLowerCase();

    ensureUser(users, username);
    const u = users[username];

    const selectedSkin = typeof req.body?.selectedSkin === "string"
        ? req.body.selectedSkin.trim()
        : "";

    if (!selectedSkin) return res.status(400).json({ error: "selectedSkin requerido" });

    const catalogIds = getCatalogSkinIds();
    if (!catalogIds.includes(selectedSkin)) {
        return res.status(400).json({ error: "selectedSkin no existe en el catálogo" });
    }

    // Ensure user owns catalog skins (free skins) and then allow selection.
    ensureInventory(u);
    u.selectedSkin = selectedSkin;
    u.avatar = skinToAvatarUrl(selectedSkin);

    saveUsers(users);

    return res.json({
        ok: true,
        user: publicProfileUser(u, username)
    });
});

/* =========================
   POINTS SYNC API (for Render)
========================= */
app.post("/api/points", requireToken, (req, res) => {
    const username = String(req.body?.username || "").toLowerCase().trim();
    const amount = Number(req.body?.amount || 0);
    const avatar = sanitizeAvatar(req.body?.avatar);
    const applyXp = req.body?.applyXp !== false;

    if (!username) return res.status(400).json({ error: "username requerido" });
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "amount inválido" });

    const users = readUsers();
    ensureUser(users, username);

    if (avatar) {
        users[username].avatar = avatar;
    }

    addPointsToUser(users, username, amount, applyXp);
    saveUsers(users);

    return res.json({ ok: true, user: users[username] });
});

app.post("/api/duel/habilidad-win", requireToken, (req, res) => {
    const username = String(req.body?.username || "").toLowerCase().trim();
    if (!username) return res.status(400).json({ error: "username requerido" });

    const users = readUsers();
    applyHabilidadDuelWin(users, username);
    saveUsers(users);

    return res.json({ ok: true, user: publicProfileUser(users[username], username) });
});

/* =========================
   DUELO (CON ID ÚNICO)
========================= */
let dueloActual = {
    id: null,
    activo: false,
    jugador1: null,
    jugador2: null,
    avatar1: null,
    avatar2: null,
    seed: null,
    ganador: null
};

app.post("/duelo", (req, res) => {

    const { jugador1, jugador2, avatar1, avatar2, seed } = req.body;
    const id = Date.now();
    const duelSeed = Number.isFinite(Number(seed)) ? Number(seed) : id;

    dueloActual = {
        id,
        activo: true,
        jugador1,
        jugador2,
        avatar1,
        avatar2,
        seed: duelSeed,
        ganador: null
    };

    console.log("⚔️ Duelo iniciado:", jugador1, "vs", jugador2);

    res.json({ ok: true });
});

app.get("/duelo", (req, res) => {
    res.json(dueloActual);
});

/* =========================
   RESULTADO (ANTI DUPLICADO)
========================= */
app.post("/duelo/resultado", (req, res) => {

    const { ganador } = req.body;

    if (dueloActual.ganador) {
        return res.json({ ok: false });
    }

    dueloActual.ganador = ganador;
    dueloActual.activo = false;

    console.log("🏆 Ganador registrado:", ganador);

    res.json({ ok: true });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
    console.log(`🔥 Server corriendo en http://localhost:${PORT}`);
});