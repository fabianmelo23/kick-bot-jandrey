require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || null;

app.use(express.json());

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

function ensureUser(users, username) {
    if (!users[username]) {
        users[username] = {
            puntos: 0,
            xp: 0,
            nivel: 1,
            avatar: "/overlay/avatar.png"
        };
    }
}

function addPointsToUser(users, username, amount) {
    ensureUser(users, username);
    const user = users[username];

    const delta = Number(amount) || 0;
    user.puntos = Number(user.puntos || 0) + delta;
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
   USERS API
========================= */
app.get("/users", (req, res) => {
    res.json(readUsers());
});

app.get("/user/:username", (req, res) => {
    const users = readUsers();
    const user = req.params.username.toLowerCase();

    if (!users[user]) {
        ensureUser(users, user);
        saveUsers(users);
    }

    res.json(users[user]);
});

/* =========================
   POINTS SYNC API (for Render)
========================= */
app.post("/api/points", requireToken, (req, res) => {
    const username = String(req.body?.username || "").toLowerCase().trim();
    const amount = Number(req.body?.amount || 0);
    const avatar = req.body?.avatar;

    if (!username) return res.status(400).json({ error: "username requerido" });
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "amount inválido" });

    const users = readUsers();
    ensureUser(users, username);

    if (typeof avatar === "string" && avatar.trim()) {
        users[username].avatar = avatar.trim();
    }

    addPointsToUser(users, username, amount);
    saveUsers(users);

    return res.json({ ok: true, user: users[username] });
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
    ganador: null
};

app.post("/duelo", (req, res) => {

    const { jugador1, jugador2, avatar1, avatar2 } = req.body;

    dueloActual = {
        id: Date.now(),
        activo: true,
        jugador1,
        jugador2,
        avatar1,
        avatar2,
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