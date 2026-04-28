const WebSocket = require("ws");
const fs = require("fs");
const axios = require("axios");

// 🔗 TU API DE RENDER
const API_URL = "https://kick-bot-jandrey-2.onrender.com/update";
const RANK_URL = "https://kick-bot-jandrey-2.onrender.com";

const CHANNEL_ID = "3086781";

const DATA_FILE = "./data/users.json";

let users = {};
let cooldown = {};

// Cargar datos
if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE));
}

// Guardar datos local
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

// 🔥 SINCRONIZAR CON RENDER
async function syncData() {
    try {
        await axios.post(API_URL, users);
        console.log("📡 Sync con Render OK");
    } catch (err) {
        console.log("❌ Error sync:", err.message);
    }
}

// Sistema de puntos
function addPoints(username, amount) {
    if (!users[username]) {
        users[username] = { puntos: 0, xp: 0, nivel: 1 };
    }

    users[username].puntos += amount;
    users[username].xp += amount;

    // subir nivel cada 100 xp
    if (users[username].xp >= 100) {
        users[username].nivel++;
        users[username].xp = 0;
        console.log(`✨ ${username} subió a nivel ${users[username].nivel}`);
    }

    saveData();
    syncData(); // 🔥 AQUÍ SE ACTUALIZA ONLINE
}

// ⚔️ DUELO
function duel(user1, user2) {
    const winner = Math.random() < 0.5 ? user1 : user2;
    const loser = winner === user1 ? user2 : user1;

    addPoints(winner, 5);
    addPoints(loser, 1);

    console.log(`🏆 ${winner} ganó vs ${loser}`);
}

// 🔌 WEBSOCKET
const ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.0.6&flash=false");

ws.on("open", () => {
    console.log("🔥 Bot conectado a Kick");

    ws.send(JSON.stringify({
        event: "pusher:subscribe",
        data: {
            channel: `chatrooms.${CHANNEL_ID}.v2`
        }
    }));
});

ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    try {
        if (msg.event === "App\\Events\\ChatMessageEvent") {
            const parsed = JSON.parse(msg.data);

            const username = parsed.sender.username.toLowerCase();
            const message = parsed.content.toLowerCase();

            console.log(`💬 ${username}: ${message}`);

            const now = Date.now();

            // cooldown simple
            if (!cooldown[username] || now - cooldown[username] > 3000) {
                addPoints(username, 1);
                cooldown[username] = now;
            }

            // ⚔️ COMANDO DUELO
            if (message.startsWith("!duelo")) {
                const target = message.split("@")[1];
                if (target) {
                    duel(username, target.toLowerCase());
                }
            }

            // 🌐 COMANDO RANKING
            if (message === "!ranking") {
                console.log(`🌐 ${username} pidió ranking → ${RANK_URL}`);
            }
        }
    } catch (e) {}
});

ws.on("error", (err) => {
    console.log("❌ Error:", err.message);
});