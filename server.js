const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SECRET = "super_secret_key_change_this";

app.use(cors());
app.use(express.json());

// раздача файлов
app.use(express.static(__dirname));

// главная страница
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

    db.run(`ALTER TABLE saves ADD COLUMN enemyPowerNerf REAL DEFAULT 1`);

    db.run(`ALTER TABLE saves ADD COLUMN speedPrice INTEGER DEFAULT 100`);

    db.run(`ALTER TABLE saves ADD COLUMN powerPrice INTEGER DEFAULT 200`);

    db.run(`ALTER TABLE saves ADD COLUMN attackSpeedPrice INTEGER DEFAULT 250`);

    db.run(`ALTER TABLE saves ADD COLUMN attackRangePrice INTEGER DEFAULT 250`);

    db.run(`ALTER TABLE saves ADD COLUMN nerfPrice INTEGER DEFAULT 300`);

});

// ================= AUTH =================

function auth(req,res,next){

    const token = req.headers.authorization;

    console.log("AUTH TOKEN:", token);

    if(!token){
        return res.status(401).json({
            error:"No token"
        });
    }

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

app.post("/register", async (req, res) => {
    const { nickname, password } = req.body;

    if (!nickname || !password) {
        return res.json({ error: "empty fields" });
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
        `INSERT INTO users(nickname,password) VALUES(?,?)`,
        [nickname, hash],
        function(err) {

            if (err) {
                return res.json({ error: "user exists" });
            }

            res.json({
                success: true,
                id: this.lastID,
                nickname: nickname
            });
        }
    );
});


app.post("/login", (req, res) => {

    const { nickname, password } = req.body;

    db.get(
        `SELECT * FROM users WHERE nickname=?`,
        [nickname],
        async (err, user) => {

            if (!user) {
                return res.json({ error: "not user found" });
            }

            const ok = await bcrypt.compare(password, user.password);

            if (!ok) {
                return res.json({ error: "wrong password" });
            }

            console.log("LOGIN USER:", user);

            const token = jwt.sign(
                { id: user.id },
                SECRET,
                { expiresIn: "7d" }
            );

            res.json({
                token,
                id: user.id,
                nickname: user.nickname
            });
        }
    );
});

app.delete("/account", auth, (req, res) => {

    const userId = req.userId;

    db.serialize(() => {

        db.run(
            "DELETE FROM saves WHERE userId=?",
            [userId]
        );

        db.run(
            "DELETE FROM users WHERE id=?",
            [userId],
            function(err){

                if(err){
                    return res.status(500).json({
                        error: err.message
                    });
                }

                res.json({
                    success:true
                });

            }
        );

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
            attackRange,

            enemyPowerNerf,

            speedPrice,
            powerPrice,
            attackSpeedPrice,
            attackRangePrice,
            nerfPrice,

            invincible,
            invincibleTimer,
            freezeHit,
            shield,
            shieldTimer
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        data.attackRange,
        data.enemyPowerNerf,
        data.speedPrice,
        data.powerPrice,
        data.attackSpeedPrice,
        data.attackRangePrice,
        data.nerfPrice,
        data.invincible ? 1 : 0,
        data.invincibleTimer,
        data.freezeHit ? 1 : 0,
        data.shield ? 1 : 0,
        data.shieldTimer
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

app.get("/player/:query", (req, res) => {

    const query = req.params.query;

    db.get(
        `
        SELECT 
            users.id,
            users.nickname,

            saves.level,
            saves.coins,
            saves.playerSpeed,
            saves.playerPower,
            saves.attackCooldown,
            saves.attackRange

        FROM users

        LEFT JOIN saves
        ON users.id = saves.userId

        WHERE users.id = ?
        OR users.nickname = ?
        `,
        [query, query],
        (err, row) => {

            if(err){
                console.log("SEARCH ERROR:", err);

                return res.status(500).json({
                    success:false,
                    error:err.message
                });
            }

            if(!row){

                return res.json({
                    success:false
                });

            }

            res.json({
                success:true,
                ...row
            });

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
