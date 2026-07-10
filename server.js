const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const http = require("http");
const { Server } = require("socket.io");

const app = express();

console.log("FILES:", require("fs").readdirSync(__dirname));
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SECRET = "super_secret_key_change_this";

const users = [];

app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "FUN.html"));
});

// ================= DATABASE =================

const db = new sqlite3.Database("./game.db", err => {
    if (err) {
        console.error(err.message);
    } else {
        console.log("SQLite connected");
    }
});

db.serialize(() => {

    db.run(`
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE,
        password TEXT
    )
    `);

    db.run(`
    CREATE TABLE IF NOT EXISTS saves(
        userId INTEGER PRIMARY KEY,

        coins INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,

        playerColor TEXT DEFAULT '#ff0000',

        playerSpeed INTEGER DEFAULT 6,
        playerPower INTEGER DEFAULT 100,

        attackCooldown INTEGER DEFAULT 800,
        attackRange INTEGER DEFAULT 50,

        FOREIGN KEY(userId) REFERENCES users(id)
    )
    `);

});

// ================= AUTH =================

function auth(req, res, next) {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: "No token" });
    }

    try {
        const decoded = jwt.verify(token, SECRET);
        req.userId = decoded.id;
        next();
    } catch (e) {
        return res.status(401).json({ error: "Invalid token" });
    }
}

// ================= REGISTER =================

app.post("/register", (req, res) => {
    const { nickname, password } = req.body;

    if (!nickname || !password) {
        return res.json({ error: "empty fields" });
    }

    const exists = users.find(u => u.nickname === nickname);

    if (exists) {
        return res.json({ error: "user exists" });
    }

    users.push({
        id: users.length + 1,
        nickname,
        password
    });

    console.log("REGISTER OK:", users);

    res.json({ success: true });
});


app.post("/login", (req, res) => {
    const { nickname, password } = req.body;

    const user = users.find(u =>
        u.nickname === nickname &&
        u.password === password
    );

    if (!user) {
        return res.json({ error: "not user found" });
    }

    const token = jwt.sign(
        { id: users.indexOf(user) + 1 },
        SECRET,
        { expiresIn: "7d" }
    );

    res.json({
        token,
        nickname
    });
});

// ================= SAVE =================

app.post("/save", auth, (req, res) => {

    const data = req.body;

    db.run(
        `
        INSERT INTO saves(
            userId,
            coins,
            level,
            playerColor,
            playerSpeed,
            playerPower,
            attackCooldown,
            attackRange
        )
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(userId)
        DO UPDATE SET
            coins=excluded.coins,
            level=excluded.level,
            playerColor=excluded.playerColor,
            playerSpeed=excluded.playerSpeed,
            playerPower=excluded.playerPower,
            attackCooldown=excluded.attackCooldown,
            attackRange=excluded.attackRange
        `,
        [
            req.userId,
            data.coins,
            data.level,
            data.playerColor,
            data.playerSpeed,
            data.playerPower,
            data.attackCooldown,
            data.attackRange
        ],
        err => {

            if(err){

                return res.status(500).json({
                    error:err.message
                });

            }

            res.json({
                success:true
            });

        }
    );

});

// ================= LOAD =================

app.post("/load", auth, (req, res) => {

    db.get(
        `
        SELECT * FROM saves
        WHERE userId=?
        `,
        [req.userId],
        (err,row)=>{

            if(err){

                return res.status(500).json({
                    error:err.message
                });

            }

            if(!row){

                return res.json({

                    coins:0,
                    level:1,

                    playerColor:"#ff0000",

                    playerSpeed:6,
                    playerPower:100,

                    attackCooldown:800,
                    attackRange:50

                });

            }

            res.json(row);

        }

    );

}); 

// ================= SOCKET.IO =================

const io = new Server(server,{

    cors:{
        origin:"*"
    }

});

const players = {};

io.on("connection",socket=>{

    console.log("Connected:",socket.id);

    players[socket.id]={

        x:3000,
        y:100,

        nickname:"Player",
        color:"#ff0000",

        map: 0

    };

    io.emit("players",players);

    socket.on("move", (data) => {
        if (!data || typeof data !== "object") return;
        if (!players[socket.id]) return;
        
        players[socket.id] = {
            ...players[socket.id],
            ...data
        };
    
        io.emit("players", players);
    });

    socket.on("pvpHit", (victimId) => {

        if (!players[victimId]) return;

        io.to(victimId).emit("damage", {
            knockX: players[socket.id].x < players[victimId].x ? 25 : -25,
            knockY: -15
        });

    });

    socket.on("disconnect",()=>{

        delete players[socket.id];

        io.emit("players",players);

        console.log("Disconnected:",socket.id);

    });

});

// ================= START =================

server.listen(PORT,"0.0.0.0",()=>{

    console.log(`Server running on port ${PORT}`);

});
