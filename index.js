const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

/* =========================
   📁 USERS JSON
========================= */
const USERS_PATH = path.join(__dirname, "data", "users.json");

function cargarUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    } catch (err) {
        console.log("⚠️ users.json vacío o no existe");
        return {};
    }
}

function guardarUsers(users) {
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function sumarPuntos(ganador) {
    const users = cargarUsers();

    if (!users[ganador]) {
        users[ganador] = {
            puntos: 0,
            xp: 0,
            nivel: 1,
            avatar: "/overlay/avatar.png"
        };
    }

    users[ganador].puntos += 5;

    guardarUsers(users);

    console.log("🏆 +5 puntos para:", ganador);
}

/* =========================
   ⚔️ SISTEMA DE DUELOS
========================= */

let enDuelo = false;
let ultimoDuelo = 0;

function puedeDuelo() {
    const ahora = Date.now();
    if (ahora - ultimoDuelo < 2 * 60 * 60 * 1000) return false;
    ultimoDuelo = ahora;
    return true;
}

/* =========================
   🚀 BOT
========================= */

(async () => {
    console.log("🔥 Iniciando bot...");

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        userDataDir: "./perfil-bot",
        args: ["--start-maximized"]
    });

    const page = await browser.newPage();

    console.log("🌐 Abriendo Kick...");
    await page.goto("https://kick.com/jandreytv", { waitUntil: "networkidle2" });

    console.log("⏳ Esperando carga completa...");
    await new Promise(r => setTimeout(r, 10000));

    console.log("🔌 Conectando WebSocket...");

    await page.exposeFunction("mensajeDesdeChat", async (user, mensaje) => {
        console.log(`💬 ${user}: ${mensaje}`);

        /* =========================
           ⚔️ COMANDO !duelo
        ========================= */

        if (mensaje.startsWith("!duelo") && !enDuelo && puedeDuelo()) {

            const partes = mensaje.split(" ");
            const rival = partes[1];

            if (!rival) return;

            enDuelo = true;

            const jugador1 = user.toLowerCase();
            const jugador2 = rival.toLowerCase();

            console.log(`⚔️ ${jugador1} vs ${jugador2}`);

            /* 🔥 SIMULACIÓN DE DUELO */
            let vida1 = 100;
            let vida2 = 100;

            while (vida1 > 0 && vida2 > 0) {

                const daño1 = Math.floor(Math.random() * 15) + 1;
                const daño2 = Math.floor(Math.random() * 15) + 1;

                vida2 -= daño1;
                vida1 -= daño2;

                await new Promise(r => setTimeout(r, 800));
            }

            const ganador = vida1 > 0 ? jugador1 : jugador2;

            console.log("🏆 Ganador:", ganador);

            /* 🔥 AQUÍ SE GUARDAN LOS PUNTOS */
            sumarPuntos(ganador);

            /* 🔥 ENVÍO AL OVERLAY */
            await fetch("http://localhost:3000/duelo", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    jugador1,
                    jugador2,
                    ganador
                })
            });

            enDuelo = false;
        }
    });

    /* =========================
       👀 LECTURA CHAT
    ========================= */

    await page.evaluate(() => {
        const chat = document.querySelector("body");

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.innerText) {

                        const texto = node.innerText;
                        const partes = texto.split("\n");

                        if (partes.length >= 2) {
                            const user = partes[0];
                            const mensaje = partes[1];

                            window.mensajeDesdeChat(user, mensaje);
                        }
                    }
                });
            });
        });

        observer.observe(chat, { childList: true, subtree: true });
    });

    console.log("✅ Bot listo escuchando chat...");
})();