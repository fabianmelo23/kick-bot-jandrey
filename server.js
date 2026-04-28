const express = require("express");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = "./data/users.json";

let users = {};

if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE));
}

// API ranking
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

// Página web
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
    load();
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log("🌐 API corriendo en puerto " + PORT);
});