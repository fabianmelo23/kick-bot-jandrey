const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const axios = require("axios");

puppeteer.use(StealthPlugin());

const URL = "https://kick.com/jandreytv";
const DATA_FILE = "./data/users.json";
const COOLDOWN_TIME = 2 * 60 * 60 * 1000;

const DEFAULT_AVATAR = "http://localhost:3000/overlay/avatar.png";

let users = {};
let duelCooldown = {};

if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE));
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

function addPoints(username, amount) {
    ensureUser(username);
    users[username].puntos += amount;
    users[username].xp += amount;
    saveData();
}

function getKey(user1, user2) {
    return [user1, user2].sort().join("_");
}

async function limpiarPestanas(browser, mainPage) {
    const pages = await browser.pages();
    for (const p of pages) {
        if (p !== mainPage) await p.close();
    }
    await mainPage.bringToFront();
}

async function sendMessage(page, text) {
    try {
        const input = await page.$('[contenteditable="true"]');
        if (!input) {
            console.log("❌ No se encontró input chat");
            return;
        }

        await input.click();
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");

        console.log("✅ Mensaje enviado:", text);

    } catch (err) {
        console.log("❌ Error enviando mensaje");
    }
}

async function duel(page, user1, user2, browser) {
    await limpiarPestanas(browser, page);

    const now = Date.now();
    const key = getKey(user1, user2);

    if (duelCooldown[key] && now - duelCooldown[key] < COOLDOWN_TIME) {
        const tiempo = Math.ceil((COOLDOWN_TIME - (now - duelCooldown[key])) / 60000);
        await sendMessage(page, `⏳ ${user1} y ${user2} deben esperar ${tiempo} min`);
        return;
    }

    duelCooldown[key] = now;

    ensureUser(user1);
    ensureUser(user2);

    const winner = Math.random() < 0.5 ? user1 : user2;
    const loser = winner === user1 ? user2 : user1;

    addPoints(winner, 5);

    await axios.post("http://localhost:3000/duelo", {
        jugador1: user1,
        jugador2: user2,
        ganador: winner,
        avatar1: users[user1].avatar,
        avatar2: users[user2].avatar
    });

    await sendMessage(page, `🏆 ${winner} ganó vs ${loser} (+5 pts)`);

    console.log("⚔️ Duelo ejecutado:", user1, "vs", user2);
}

// ---------------- MAIN ----------------
(async () => {
    console.log("🔥 Iniciando bot...");

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        userDataDir: "C:\\Users\\SantiMichell\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
        args: ["--profile-directory=Default"]
    });

    const page = await browser.newPage();

    console.log("🌐 Abriendo Kick...");
    await page.goto(URL, { waitUntil: "networkidle2" });

    console.log("⌛ Esperando carga completa...");
    await new Promise(r => setTimeout(r, 8000));

    console.log("🔌 Conectando WebSocket...");

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

                console.log("⚔️ Comando duelo detectado");

                await duel(page, username, target, browser);
            }

        } catch (err) {
            console.log("❌ Error leyendo mensaje");
        }
    });

    console.log("✅ Bot listo escuchando chat...");
})();