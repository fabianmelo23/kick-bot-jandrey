const puppeteer = require("puppeteer");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = 3000;

const DATA_FILE = "./data/users.json";

let users = {};

if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE));
}

function guardarDatos() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

function initUser(username) {
    if (!users[username]) {
        users[username] = {
            puntos: 100,
            xp: 0,
            nivel: 1
        };
    }
}

function checkLevelUp(username) {
    let user = users[username];
    let requiredXP = user.nivel * 50;

    if (user.xp >= requiredXP) {
        user.xp -= requiredXP;
        user.nivel += 1;
        console.log(`✨ ${username} subió a nivel ${user.nivel}`);
    }
}

// 🌐 API ranking
app.get("/ranking", (req, res) => {
    const ranking = Object.entries(users)
        .map(([name, data]) => ({
            name,
            puntos: data.puntos
        }))
        .sort((a, b) => b.puntos - a.puntos)
        .slice(0, 10);

    res.json(ranking);
});

// 🌐 WEB
app.get("/", (req, res) => {
    res.send(`
    <html>
    <body style="background:#0f172a;color:white;text-align:center">
    <h1>🏆 Ranking</h1>
    <div id="data"></div>

    <script>
    async function load(){
        const res = await fetch('/ranking');
        const data = await res.json();
        document.getElementById('data').innerHTML =
            data.map((u,i)=>\`\${i+1}. \${u.name} - \${u.puntos} pts<br>\`).join('');
    }
    setInterval(load,2000);
    load();
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log("🌐 http://localhost:3000");
});

let cooldown = {};

(async () => {
    console.log("🔥 Bot ESTABLE DEFINITIVO");

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });

    const page = await browser.newPage();

    await page.goto("https://kick.com/jandreytv", {
        waitUntil: "networkidle2"
    });

    await page.waitForSelector('div[class*="chat"]');

    await page.exposeFunction("onNewMessage", (username, message) => {

        const usernameValido = /^[a-zA-Z0-9_]{3,20}$/.test(username);
        if (!usernameValido || !message) return;

        message = message.trim().toLowerCase();

        console.log(`💬 ${username}: ${message}`);

        initUser(username);

        const now = Date.now();
        if (cooldown[username] && now - cooldown[username] < 3000) return;

        // 🌐 COMANDO RANKING
        if (message === "!ranking") {
            cooldown[username] = now;
            console.log(`🌐 ${username} → http://localhost:3000`);
            return;
        }

        // ⚔️ DUEL0
        if (message.startsWith("!duelo")) {
            const rival = message.split(" ")[1]?.replace("@", "");

            if (!rival || rival === username) return;

            initUser(rival);
            cooldown[username] = now;

            const atk1 = Math.floor(Math.random() * 100);
            const atk2 = Math.floor(Math.random() * 100);

            let ganador, perdedor;

            if (atk1 > atk2) {
                ganador = username;
                perdedor = rival;
            } else if (atk2 > atk1) {
                ganador = rival;
                perdedor = username;
            } else {
                console.log("🤝 Empate");
                return;
            }

            users[ganador].puntos += 5;
            users[perdedor].puntos += 1;

            users[ganador].xp += 10;
            users[perdedor].xp += 3;

            checkLevelUp(ganador);
            checkLevelUp(perdedor);

            guardarDatos();

            console.log(`🏆 ${ganador} ganó vs ${perdedor}`);
        }
    });

    await page.evaluate(() => {

        let initialized = false;
        let lastMessages = new Set();

        const obs = new MutationObserver(() => {
            const nodes = document.querySelectorAll("div");

            nodes.forEach(msg => {
                const t = msg.innerText?.trim();
                if (!t || !t.includes(":")) return;

                // 🔥 IGNORAR MENSAJES VIEJOS AL INICIAR
                if (!initialized) {
                    lastMessages.add(t);
                    return;
                }

                // evitar repetidos
                if (lastMessages.has(t)) return;

                lastMessages.add(t);

                const parts = t.split(":");
                if (parts.length < 2) return;

                const user = parts[0].trim();
                const msgTxt = parts.slice(1).join(":").trim();

                if (user && msgTxt) {
                    window.onNewMessage(user, msgTxt);
                }
            });

            initialized = true;
        });

        obs.observe(document.body, { childList: true, subtree: true });
    });
})();