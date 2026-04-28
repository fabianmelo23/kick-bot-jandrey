const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* 🔥 SERVIR ARCHIVOS */
app.use("/overlay", express.static(path.join(__dirname, "overlay")));
app.use("/panel", express.static(path.join(__dirname, "panel")));
app.use("/", express.static(path.join(__dirname, "ranking"))); // tu ranking

/* 🔥 RUTA USERS (LA QUE FALTABA) */
app.get("/users", (req, res) => {
    try {
        const filePath = path.join(__dirname, "data", "users.json");

        if (!fs.existsSync(filePath)) {
            return res.json({});
        }

        const users = JSON.parse(fs.readFileSync(filePath, "utf8"));

        res.json(users);

    } catch (err) {
        console.error("Error leyendo users:", err);
        res.status(500).json({ error: "Error leyendo users" });
    }
});

/* 🔥 RUTA DUELO (ya la tienes pero la dejamos bien) */
let duelo = {};

app.get("/duelo", (req, res) => {
    res.json(duelo);
});

app.post("/duelo", (req, res) => {
    duelo = {
        ...req.body,
        activo: true
    };

    res.json({ ok: true });

    setTimeout(() => {
        duelo = {};
    }, 10000);
});

/* 🔥 SERVER */
app.listen(PORT, () => {
    console.log("🔥 Server corriendo en puerto " + PORT);
});