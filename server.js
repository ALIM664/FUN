
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "change_this_secret";

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================= MAIN PAGE =================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "FUN.html"));
});

// ================= DATABASE =================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ================= DATABASE INIT =================

async function initDB() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            nickname TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS saves(
            userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

            coins INTEGER DEFAULT 0,
            points INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,

            playerColor TEXT DEFAULT '#ff0000',
            playerNickname TEXT,

            playerSpeed INTEGER DEFAULT 6,
            playerPower INTEGER DEFAULT 100,

            attackCooldown INTEGER DEFAULT 800,
            attackRange INTEGER DEFAULT 50,

            enemyPowerNerf REAL DEFAULT 1,

            speedPrice INTEGER DEFAULT 100,
            powerPrice INTEGER DEFAULT 200,
            attackSpeedPrice INTEGER DEFAULT 250,
            attackRangePrice INTEGER DEFAULT 250,
            nerfPrice INTEGER DEFAULT 300,

            immortal INTEGER DEFAULT 0,
            immortalTimer INTEGER DEFAULT 0,

            doubleJump INTEGER DEFAULT 0,
            doubleJumpCount INTEGER DEFAULT 0,

            currentMap INTEGER DEFAULT 0,

            playerX REAL DEFAULT 3000,
            playerY REAL DEFAULT 100
        )
    `);

    // ================= SAVE STATUS MIGRATION =================

    await pool.query(`
        ALTER TABLE saves
        ADD COLUMN IF NOT EXISTS hasSave BOOLEAN
    `);

    // Определяем, у каких старых аккаунтов уже был прогресс.
    // Полностью начальное старое сохранение невозможно
    // отличить от записи, созданной при регистрации.

    await pool.query(`
        UPDATE saves
        SET hasSave = (
            COALESCE(coins, 0) <> 0 OR
            COALESCE(points, 0) <> 0 OR
            COALESCE(level, 1) <> 1 OR
            COALESCE(playercolor, '#ff0000') <> '#ff0000' OR
            COALESCE(playerspeed, 6) <> 6 OR
            COALESCE(playerpower, 100) <> 100 OR
            COALESCE(attackcooldown, 800) <> 800 OR
            COALESCE(attackrange, 50) <> 50 OR
            COALESCE(enemypowernerf, 1) <> 1 OR
            COALESCE(speedprice, 100) <> 100 OR
            COALESCE(powerprice, 200) <> 200 OR
            COALESCE(attackspeedprice, 250) <> 250 OR
            COALESCE(attackrangeprice, 250) <> 250 OR
            COALESCE(nerfprice, 300) <> 300 OR
            COALESCE(immortal, 0) <> 0 OR
            COALESCE(immortaltimer, 0) <> 0 OR
            COALESCE(doublejump, 0) <> 0 OR
            COALESCE(doublejumpcount, 0) <> 0 OR
            COALESCE(currentmap, 0) <> 0 OR
            COALESCE(playerx, 3000) <> 3000 OR
            COALESCE(playery, 100) <> 100
        )
        WHERE hasSave IS NULL
    `);

    await pool.query(`
        ALTER TABLE saves
        ALTER COLUMN hasSave SET DEFAULT FALSE
    `);

    await pool.query(`
        ALTER TABLE saves
        ALTER COLUMN hasSave SET NOT NULL
    `);

    console.log("POSTGRES TABLES READY");
}

// ================= AUTH =================

function auth(req, res, next) {

    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({
            error: "No token"
        });
    }

    try {

        const decoded = jwt.verify(token, SECRET);

        req.userId = decoded.id;

        next();

    } catch (err) {

        return res.status(401).json({
            error: "Invalid token"
        });

    }
}

// ================= REGISTER =================

// ================= REGISTER =================

app.post("/register", async (req, res) => {

    const nickname = String(req.body?.nickname || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!nickname || !password) {
        return res.status(400).json({
            success: false,
            error: "Заполни все поля!"
        });
    }

    if (nickname.length > 20 || password.length > 30) {
        return res.status(400).json({
            success: false,
            error: "Слишком длинный ник или пароль!"
        });
    }

    let db;
    let transactionStarted = false;

    try {

        db = await pool.connect();

        await db.query("BEGIN");
        transactionStarted = true;

        const hash = await bcrypt.hash(password, 10);

        const user = await db.query(
            `
            INSERT INTO users(nickname, password)
            VALUES($1, $2)
            RETURNING id, nickname
            `,
            [nickname, hash]
        );

        const id = user.rows[0].id;

        // Создаём начальное сохранение
        await db.query(
            `
            INSERT INTO saves(
                userId,
                playerNickname,
                hasSave
            )
            VALUES($1, $2, FALSE)
            `,
            [id, nickname]
        );

        await db.query("COMMIT");
        transactionStarted = false;

        console.log("ACCOUNT CREATED:", nickname);

        res.status(201).json({
            success: true,
            id,
            nickname
        });

    } catch (err) {

        if (transactionStarted && db) {
            await db.query("ROLLBACK").catch(console.error);
        }

        console.error("REGISTER ERROR:", err);

        if (err.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "Такой ник уже занят!"
            });
        }

        res.status(500).json({
            success: false,
            error: "Ошибка создания аккаунта",
            details: err.message
        });

    } finally {

        if (db) {
            db.release();
        }

    }

});

// ================= LOGIN =================

app.post("/login", async (req, res) => {

    const { nickname, password } = req.body;

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE nickname = $1
            `,
            [nickname]
        );

        const user = result.rows[0];

        if (!user) {
            return res.json({
                error: "not user found"
            });
        }

        const ok = await bcrypt.compare(
            password,
            user.password
        );

        if (!ok) {
            return res.json({
                error: "wrong password"
            });
        }

        const token = jwt.sign(
            {
                id: user.id
            },
            SECRET,
            {
                expiresIn: "7d"
            }
        );

        res.json({
            success: true,
            token,
            id: user.id,
            nickname: user.nickname
        });

    } catch (err) {

        console.log("LOGIN ERROR:", err);

        res.status(500).json({
            error: err.message
        });

    }

});

// ================= SAVE GAME =================

app.post("/save", auth, async (req, res) => {

    const data = req.body;

    try {

        await pool.query(
            `
            INSERT INTO saves(
                userId,

                coins,
                points,
                level,

                playerColor,
                playerNickname,

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

                immortal,
                immortalTimer,

                doubleJump,
                doubleJumpCount,

                currentMap,

                playerX,
                playerY,
                hasSave
            )

            VALUES(
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                $15,
                $16,
                $17,
                $18,
                $19,
                $20,
                $21,
                $22,
                $23,
                $24,
                TRUE
            )

            ON CONFLICT(userId)
            DO UPDATE SET

                coins = EXCLUDED.coins,
                points = EXCLUDED.points,
                level = EXCLUDED.level,

                playerColor = EXCLUDED.playerColor,
                playerNickname = EXCLUDED.playerNickname,

                playerSpeed = EXCLUDED.playerSpeed,
                playerPower = EXCLUDED.playerPower,

                attackCooldown = EXCLUDED.attackCooldown,
                attackRange = EXCLUDED.attackRange,

                enemyPowerNerf = EXCLUDED.enemyPowerNerf,

                speedPrice = EXCLUDED.speedPrice,
                powerPrice = EXCLUDED.powerPrice,
                attackSpeedPrice = EXCLUDED.attackSpeedPrice,
                attackRangePrice = EXCLUDED.attackRangePrice,
                nerfPrice = EXCLUDED.nerfPrice,

                immortal = EXCLUDED.immortal,
                immortalTimer = EXCLUDED.immortalTimer,

                doubleJump = EXCLUDED.doubleJump,
                doubleJumpCount = EXCLUDED.doubleJumpCount,

                currentMap = EXCLUDED.currentMap,

                playerX = EXCLUDED.playerX,
                playerY = EXCLUDED.playerY,
                hasSave = TRUE
            `,
            [
                req.userId,

                data.coins ?? 0,
                data.points ?? 0,
                data.level ?? 1,

                data.playerColor ?? "#ff0000",
                data.playerNickname ?? null,

                data.playerSpeed ?? 6,
                data.playerPower ?? 100,

                data.attackCooldown ?? 800,
                data.attackRange ?? 50,

                data.enemyPowerNerf ?? 1,

                data.speedPrice ?? 100,
                data.powerPrice ?? 200,
                data.attackSpeedPrice ?? 250,
                data.attackRangePrice ?? 250,
                data.nerfPrice ?? 300,

                data.immortal ? 1 : 0,
                data.immortalTimer ?? 0,

                data.doubleJump ? 1 : 0,
                data.doubleJumpCount ?? 0,

                data.currentMap ?? 0,

                data.playerX ?? 3000,
                data.playerY ?? 100
            ]
        );

        res.json({
            success: true
        });

    } catch (err) {

        console.log("SAVE ERROR:", err);

        res.status(500).json({
            error: err.message
        });

    }

});

// ================= LOAD GAME =================

app.post("/load", auth, async (req, res) => {

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM saves
            WHERE userId = $1
            `,
            [req.userId]
        );

        // Если серверного сохранения нет,
        // клиент должен проверить локальную копию.

        if (
            result.rows.length === 0 ||
            !result.rows[0].hassave
        ) {

            return res.json({
                exists: false
            });

        }

        const row = result.rows[0];

        return res.json({

            exists: true,

            data: {

                coins: row.coins,
                points: row.points,
                level: row.level,

                playerColor: row.playercolor,
                playerNickname: row.playernickname,

                playerSpeed: row.playerspeed,
                playerPower: row.playerpower,

                attackCooldown: row.attackcooldown,
                attackRange: row.attackrange,

                enemyPowerNerf: row.enemypowernerf,

                speedPrice: row.speedprice,
                powerPrice: row.powerprice,
                attackSpeedPrice: row.attackspeedprice,
                attackRangePrice: row.attackrangeprice,
                nerfPrice: row.nerfprice,

                immortal: Boolean(row.immortal),
                immortalTimer: row.immortaltimer,

                doubleJump: Boolean(row.doublejump),
                doubleJumpCount: row.doublejumpcount,

                currentMap: row.currentmap,

                playerX: row.playerx,
                playerY: row.playery

            }

        });

    } catch (err) {

        console.log("LOAD ERROR:", err);

        return res.status(500).json({
            error: err.message
        });

    }

});

// ================= SOCKET.IO =================

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

const players = {};

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    players[socket.id] = {
        x: 3000,
        y: 100,

        nickname: "Player",
        color: "#ff0000",

        playerTitle: "beginner lvl.1",

        userId: null,

        playerPoint: 1,

        map: 0
    };

    io.emit("players", players);

    // ================= PLAYER DATA =================

    socket.on("setPlayerData", (data) => {

        if (!data) return;
        if (!players[socket.id]) return;

        players[socket.id].userId =
            data.userId || null;

        players[socket.id].nickname =
            data.nickname || "Player";

        players[socket.id].playerPoint =
            data.playerPoint || 1;

        players[socket.id].color =
            data.color || "#ff0000";

        players[socket.id].playerTitle =
            data.playerTitle || "beginner lvl.1";

        io.emit("players", players);

    });

    // ================= MOVE =================

    socket.on("move", (data) => {

        if (!data || typeof data !== "object") {
            return;
        }

        if (!players[socket.id]) {
            return;
        }

        players[socket.id] = {
            ...players[socket.id],
            ...data
        };

        io.emit("players", players);

    });

    // ================= UPDATE TITLE =================

    socket.on("updateTitle", (title) => {

        if (!players[socket.id]) {
            return;
        }

        players[socket.id].playerTitle =
            String(title || "beginner lvl.1");

        io.emit("players", players);

    });

    // ================= DISCONNECT =================

    socket.on("disconnect", () => {

        delete players[socket.id];

        io.emit("players", players);

        console.log("Disconnected:", socket.id);

    });

});

// ================= START =================

initDB()
    .then(() => {

        server.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `Server running on port ${PORT}`
                );

            }
        );

    })
    .catch(err => {

        console.error(
            "DATABASE INIT ERROR:",
            err
        );

    });
