
"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 3000;

const ROLE =
    process.argv[2] ||
    process.env.SERVICE_ROLE ||
    "primary";

const SECRET =
    process.env.JWT_SECRET || "change_this_secret";

const DATABASE_URL = process.env.DATABASE_URL;

const BACKUP_URL =
    (process.env.BACKUP_URL || "").replace(/\/+$/, "");

const BACKUP_SECRET =
    process.env.BACKUP_SECRET || "";

const BACKUP_DIR =
    process.env.BACKUP_DIR || "/var/data/backups";

const BACKUP_KEEP =
    Math.max(1, Number(process.env.BACKUP_KEEP || 144));

const BACKUP_MAX_MB =
    Math.max(1, Number(process.env.BACKUP_MAX_MB || 2048));

const BACKUP_MAX_BYTES =
    BACKUP_MAX_MB * 1024 * 1024;

const RESTORE_ON_SHRINK =
    process.env.RESTORE_ON_SHRINK !== "false";

const app = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

let pool = null;
let maintenanceMode = false;
let restoreRunning = false;

// =====================================================
// COMMON
// =====================================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        role: ROLE,
        maintenance: maintenanceMode
    });
});

app.use((req, res, next) => {

    if (maintenanceMode && req.path !== "/health") {
        return res.status(503).json({
            error: "Server restoring database"
        });
    }

    next();

});

function createPool() {

    if (!DATABASE_URL) {
        throw new Error("DATABASE_URL is missing");
    }

    return new Pool({
        connectionString: DATABASE_URL,

        ssl: {
            rejectUnauthorized: false
        },

        max: 5,

        idleTimeoutMillis: 30000,

        connectionTimeoutMillis: 10000
    });

}

function quoteIdent(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
}

function backupAuth(req, res, next) {

    if (!BACKUP_SECRET) {
        return res.status(503).json({
            error: "BACKUP_SECRET is not configured"
        });
    }

    const received =
        req.headers["x-backup-secret"] || "";

    const a = Buffer.from(String(received));
    const b = Buffer.from(BACKUP_SECRET);

    const valid =
        a.length === b.length &&
        crypto.timingSafeEqual(a, b);

    if (!valid) {
        return res.status(401).json({
            error: "Invalid backup secret"
        });
    }

    next();

}

function backupRequest(route, options = {}) {

    if (!BACKUP_URL || !BACKUP_SECRET) {
        throw new Error("BACKUP_URL or BACKUP_SECRET missing");
    }

    return fetch(
        BACKUP_URL + route,
        {
            ...options,

            headers: {
                ...(options.headers || {}),
                "x-backup-secret": BACKUP_SECRET
            }
        }
    );

}

function runCommand(command, args) {

    return new Promise((resolve, reject) => {

        const child = spawn(command, args, {
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"]
        });

        let stderr = "";

        child.stderr.on("data", chunk => {

            if (stderr.length < 25000) {
                stderr += chunk.toString();
            }

        });

        child.on("error", reject);

        child.on("close", code => {

            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(
                        command +
                        " failed with code " +
                        code +
                        "\n" +
                        stderr
                    )
                );
            }

        });

    });

}

// =====================================================
// DATABASE TABLE COUNTS
// =====================================================

// Automatically discovers all ordinary and partitioned
// tables in every non-system schema.

async function collectTableCounts(db) {

    const result = await db.query(`
        SELECT
            n.nspname AS schema_name,
            c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n
            ON n.oid = c.relnamespace
        WHERE
            c.relkind IN ('r', 'p')
            AND n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
            AND n.nspname NOT LIKE 'pg_temp_%'
        ORDER BY n.nspname, c.relname
    `);

    const counts = {};

    for (const row of result.rows) {

        const key =
            row.schema_name + "." + row.table_name;

        const sql = `
            SELECT COUNT(*)::text AS count
            FROM ${quoteIdent(row.schema_name)}.${quoteIdent(row.table_name)}
        `;

        const countResult = await db.query(sql);

        counts[key] = countResult.rows[0].count;

    }

    return counts;

}

function snapshotHasShrink(oldCounts, newCounts) {

    if (!oldCounts || typeof oldCounts !== "object") {
        return false;
    }

    for (const key of Object.keys(oldCounts)) {

        const oldValue = BigInt(oldCounts[key] || 0);

        const newValue = BigInt(newCounts[key] ?? 0);

        if (newCounts[key] === undefined || newValue < oldValue) {
            return true;
        }

    }

    return false;

}

function databaseNeedsRestore(current, backup) {

    const expected = backup.tableCounts || {};

    const names = Object.keys(expected);

    if (names.length === 0) {
        return false;
    }

    if (
        RESTORE_ON_SHRINK &&
        snapshotHasShrink(expected, current)
    ) {
        return true;
    }

    return false;

}

// =====================================================
// BACKUP SERVER
// =====================================================

function installBackupServer() {

    // Receive a complete PostgreSQL archive.

    app.put(
        "/internal/backup",
        backupAuth,
        async (req, res) => {

            let meta;

            try {

                const header =
                    req.headers["x-backup-meta"];

                if (!header || header.length > 12000) {
                    return res.status(400).json({
                        error: "Invalid backup metadata"
                    });
                }

                meta = JSON.parse(
                    Buffer.from(header, "base64url").toString("utf8")
                );

                if (
                    !meta ||
                    typeof meta.tableCounts !== "object" ||
                    !meta.createdAt
                ) {
                    return res.status(400).json({
                        error: "Incomplete backup metadata"
                    });
                }

            } catch (err) {

                return res.status(400).json({
                    error: "Cannot read backup metadata"
                });

            }

            const id = crypto.randomUUID();

            const filename =
                `fun-${Date.now()}-${id}.dump`;

            const tempPath = path.join(
                BACKUP_DIR,
                `upload-${id}.tmp`
            );

            const finalPath = path.join(
                BACKUP_DIR,
                filename
            );

            const metaPath = finalPath + ".json";

            let bytes = 0;

            const limiter = new Transform({

                transform(chunk, encoding, callback) {

                    bytes += chunk.length;

                    if (bytes > BACKUP_MAX_BYTES) {
                        return callback(
                            new Error("BACKUP_TOO_LARGE")
                        );
                    }

                    callback(null, chunk);

                }

            });

            try {

                await pipeline(
                    req,
                    limiter,
                    fs.createWriteStream(tempPath, {
                        flags: "wx"
                    })
                );

                if (bytes === 0) {
                    throw new Error("Empty backup");
                }

                await fsp.rename(tempPath, finalPath);

                const savedMeta = {

                    ...meta,

                    filename,

                    sizeBytes: bytes,

                    receivedAt: new Date().toISOString()

                };

                await fsp.writeFile(
                    metaPath,
                    JSON.stringify(savedMeta, null, 2),
                    { flag: "wx" }
                );

                await pruneBackups();

                console.log("BACKUP RECEIVED:", filename);

                return res.status(201).json({
                    success: true,
                    filename,
                    sizeBytes: bytes
                });

            } catch (err) {

                await fsp.unlink(tempPath).catch(() => {});

                console.error("BACKUP RECEIVE ERROR:", err);

                return res.status(
                    err.message === "BACKUP_TOO_LARGE" ? 413 : 500
                ).json({
                    success: false,
                    error: err.message
                });

            }

        }
    );

    // Return the latest backup metadata.

    app.get(
        "/internal/latest",
        backupAuth,
        async (req, res) => {

            try {

                const entries = await fsp.readdir(BACKUP_DIR);

                const manifests =
                    entries.filter(name => name.endsWith(".dump.json"));

                const backups = [];

                for (const name of manifests) {

                    try {

                        const fullPath =
                            path.join(BACKUP_DIR, name);

                        const meta = JSON.parse(
                            await fsp.readFile(fullPath, "utf8")
                        );

                        backups.push(meta);

                    } catch (err) {

                        console.error("BAD BACKUP META:", name);

                    }

                }

                backups.sort((a, b) => {
                    return new Date(b.createdAt) - new Date(a.createdAt);
                });

                if (backups.length === 0) {
                    return res.status(404).json({
                        exists: false
                    });
                }

                res.json({
                    exists: true,
                    backup: backups[0]
                });

            } catch (err) {

                console.error("LATEST BACKUP ERROR:", err);

                res.status(500).json({
                    error: err.message
                });

            }

        }
    );

    // Download an archive.

    app.get(
        "/internal/download/:filename",
        backupAuth,
        async (req, res) => {

            const filename = req.params.filename;

            if (!/^fun-[a-zA-Z0-9-]+\.dump$/.test(filename)) {
                return res.status(400).json({
                    error: "Invalid filename"
                });
            }

            const fullPath =
                path.join(BACKUP_DIR, filename);

            try {

                const stat = await fsp.stat(fullPath);

                res.setHeader(
                    "Content-Type",
                    "application/octet-stream"
                );

                res.setHeader(
                    "Content-Length",
                    stat.size
                );

                fs.createReadStream(fullPath).pipe(res);

            } catch (err) {

                res.status(404).json({
                    error: "Backup not found"
                });

            }

        }
    );

}

// =====================================================
// BACKUP RETENTION
// =====================================================

async function pruneBackups() {

    const entries = await fsp.readdir(BACKUP_DIR);

    const backups = [];

    for (const name of entries) {

        if (!name.endsWith(".dump.json")) continue;

        try {

            const fullPath = path.join(BACKUP_DIR, name);

            const meta = JSON.parse(
                await fsp.readFile(fullPath, "utf8")
            );

            backups.push({
                meta,
                metaPath: fullPath,
                archivePath: path.join(
                    BACKUP_DIR,
                    meta.filename
                )
            });

        } catch (err) {

            console.error("PRUNE META ERROR:", name);

        }

    }

    backups.sort((a, b) => {
        return new Date(b.meta.createdAt) -
               new Date(a.meta.createdAt);
    });

    for (const item of backups.slice(BACKUP_KEEP)) {

        await fsp.unlink(item.archivePath).catch(() => {});
        await fsp.unlink(item.metaPath).catch(() => {});

        console.log(
            "OLD BACKUP REMOVED:",
            item.meta.filename
        );

    }

}

// =====================================================
// LATEST BACKUP
// =====================================================

async function getLatestBackup() {

    const res = await backupRequest(
        "/internal/latest",
        {
            signal: AbortSignal.timeout(15000)
        }
    );

    if (res.status === 404) {
        return null;
    }

    if (!res.ok) {
        throw new Error(
            "BACKUP SERVER HTTP " + res.status
        );
    }

    const data = await res.json();

    if (!data.exists || !data.backup) {
        return null;
    }

    return data.backup;

}

// =====================================================
// DOWNLOAD BACKUP
// =====================================================

async function downloadBackup(meta) {

    const filename = meta.filename;

    if (!/^fun-[a-zA-Z0-9-]+\.dump$/.test(filename)) {
        throw new Error("Invalid backup filename");
    }

    const res = await backupRequest(
        "/internal/download/" + encodeURIComponent(filename),
        {
            signal: AbortSignal.timeout(30 * 60 * 1000)
        }
    );

    if (!res.ok || !res.body) {
        throw new Error("Cannot download backup");
    }

    const localPath = path.join(
        os.tmpdir(),
        `fun-restore-${crypto.randomUUID()}.dump`
    );

    await pipeline(
        Readable.fromWeb(res.body),
        fs.createWriteStream(localPath, {
            flags: "wx"
        })
    );

    return localPath;

}

// =====================================================
// AUTOMATIC RESTORE
// =====================================================

async function maybeRestoreFromBackup(reason) {

    if (restoreRunning) return false;

    if (!BACKUP_URL || !BACKUP_SECRET) {
        return false;
    }

    restoreRunning = true;

    let localBackupPath = null;

    try {

        const backup = await getLatestBackup();

        if (!backup) {
            return false;
        }

        let currentCounts;

        try {

            currentCounts = await collectTableCounts(pool);

        } catch (err) {

            console.error(
                "MAIN DATABASE CHECK FAILED:",
                err.message
            );

            currentCounts = {};

        }

        const needsRestore =
            databaseNeedsRestore(currentCounts, backup);

        if (!needsRestore) {
            return false;
        }

        console.error(
            "DATABASE LOSS DETECTED. RESTORING:",
            reason
        );

        maintenanceMode = true;

        const oldPool = pool;

        pool = null;

        if (oldPool) {
            await oldPool.end().catch(err => {
                console.error("OLD POOL CLOSE ERROR:", err.message);
            });
        }

        try {

            localBackupPath = await downloadBackup(backup);

            // Restore the full database archive.
            // This operation changes existing database objects.

            await runCommand("pg_restore", [

                "--exit-on-error",

                "--single-transaction",

                "--clean",
                "--if-exists",

                "--no-owner",
                "--no-privileges",

                "--dbname",
                DATABASE_URL,

                localBackupPath

            ]);

            console.log("DATABASE RESTORED:", backup.filename);

        } finally {

            pool = createPool();

        }

        await initDB();

        console.log("AUTOMATIC RESTORE COMPLETE");

        return true;

    } catch (err) {

        console.error("AUTO RESTORE ERROR:", err);

        if (!pool && DATABASE_URL) {
            pool = createPool();
        }

        return false;

    } finally {

        if (localBackupPath) {
            await fsp.unlink(localBackupPath).catch(() => {});
        }

        maintenanceMode = false;
        restoreRunning = false;

    }

}

// =====================================================
// DATABASE INIT AND MIGRATIONS
// =====================================================

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

            userId INTEGER PRIMARY KEY
                REFERENCES users(id) ON DELETE CASCADE,

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
            playerY REAL DEFAULT 100,

            hasSave BOOLEAN DEFAULT FALSE NOT NULL
        )
    `);

    // Add missing fields to old databases.

    await pool.query(`
        ALTER TABLE saves

        ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1,

        ADD COLUMN IF NOT EXISTS playerColor TEXT DEFAULT '#ff0000',
        ADD COLUMN IF NOT EXISTS playerNickname TEXT,

        ADD COLUMN IF NOT EXISTS playerSpeed INTEGER DEFAULT 6,
        ADD COLUMN IF NOT EXISTS playerPower INTEGER DEFAULT 100,

        ADD COLUMN IF NOT EXISTS attackCooldown INTEGER DEFAULT 800,
        ADD COLUMN IF NOT EXISTS attackRange INTEGER DEFAULT 50,

        ADD COLUMN IF NOT EXISTS enemyPowerNerf REAL DEFAULT 1,

        ADD COLUMN IF NOT EXISTS speedPrice INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS powerPrice INTEGER DEFAULT 200,
        ADD COLUMN IF NOT EXISTS attackSpeedPrice INTEGER DEFAULT 250,
        ADD COLUMN IF NOT EXISTS attackRangePrice INTEGER DEFAULT 250,
        ADD COLUMN IF NOT EXISTS nerfPrice INTEGER DEFAULT 300,

        ADD COLUMN IF NOT EXISTS immortal INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS immortalTimer INTEGER DEFAULT 0,

        ADD COLUMN IF NOT EXISTS doubleJump INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS doubleJumpCount INTEGER DEFAULT 0,

        ADD COLUMN IF NOT EXISTS currentMap INTEGER DEFAULT 0,

        ADD COLUMN IF NOT EXISTS playerX REAL DEFAULT 3000,
        ADD COLUMN IF NOT EXISTS playerY REAL DEFAULT 100,

        ADD COLUMN IF NOT EXISTS hasSave BOOLEAN DEFAULT FALSE
    `);

    // Detect old existing progress.

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

// =====================================================
// AUTH
// =====================================================

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

// =====================================================
// PRIMARY GAME ROUTES
// =====================================================

function installPrimaryRoutes() {

    app.use(express.static(__dirname));

    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "FUN.html"));
    });

    // ================= REGISTER =================

    app.post("/register", async (req, res) => {

        const nickname =
            String(req.body?.nickname || "").trim();

        const password =
            String(req.body?.password || "").trim();

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

        let db = null;
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

            if (db) db.release();

        }

    });

    // ================= LOGIN =================

    app.post("/login", async (req, res) => {

        const nickname =
            String(req.body?.nickname || "").trim();

        const password =
            String(req.body?.password || "").trim();

        if (!nickname || !password) {
            return res.status(400).json({
                success: false,
                error: "Заполни все поля"
            });
        }

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
                return res.status(404).json({
                    success: false,
                    error: "not user found"
                });
            }

            const ok = await bcrypt.compare(
                password,
                user.password
            );

            if (!ok) {
                return res.status(401).json({
                    success: false,
                    error: "wrong password"
                });
            }

            const token = jwt.sign(
                { id: user.id },
                SECRET,
                { expiresIn: "7d" }
            );

            res.json({
                success: true,
                token,
                id: user.id,
                nickname: user.nickname
            });

        } catch (err) {

            console.error("LOGIN ERROR:", err);

            res.status(500).json({
                success: false,
                error: err.message
            });

        }

    });

    // ================= SAVE GAME =================

    app.post("/save", auth, async (req, res) => {

        const data = req.body || {};

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
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18,
                    $19, $20, $21, $22, $23, TRUE
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

            console.error("SAVE ERROR:", err);

            res.status(500).json({
                success: false,
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

            if (
                result.rows.length === 0 ||
                result.rows[0].hassave !== true
            ) {

                return res.json({
                    exists: false
                });

            }

            const row = result.rows[0];

            res.json({

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

            console.error("LOAD ERROR:", err);

            res.status(500).json({
                error: err.message
            });

        }

    });

    // ================= SOCKET.IO =================

    const io = new Server(httpServer, {
        cors: {
            origin: "*"
        }
    });

    const players = {};

    io.on("connection", socket => {

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

        // PLAYER DATA

        socket.on("setPlayerData", data => {

            if (!data || !players[socket.id]) return;

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

        // MOVE

        socket.on("move", data => {

            if (!data || typeof data !== "object") return;
            if (!players[socket.id]) return;

            players[socket.id] = {
                ...players[socket.id],
                ...data
            };

            io.emit("players", players);

        });

        // UPDATE TITLE

        socket.on("updateTitle", title => {

            if (!players[socket.id]) return;

            players[socket.id].playerTitle =
                String(title || "beginner lvl.1");

            io.emit("players", players);

        });

        // DISCONNECT

        socket.on("disconnect", () => {

            delete players[socket.id];

            io.emit("players", players);

            console.log("Disconnected:", socket.id);

        });

    });

}

// =====================================================
// BACKUP JOB
// =====================================================

// Creates a complete consistent PostgreSQL snapshot.
// No list of tables or columns is hardcoded.

async function runBackupJob() {

    if (!DATABASE_URL) {
        throw new Error("DATABASE_URL missing");
    }

    if (!BACKUP_URL || !BACKUP_SECRET) {
        throw new Error("BACKUP_URL or BACKUP_SECRET missing");
    }

    pool = createPool();

    const previous = await getLatestBackup();

    const client = await pool.connect();

    const localPath = path.join(
        os.tmpdir(),
        `fun-backup-${crypto.randomUUID()}.dump`
    );

    let transactionStarted = false;

    try {

        // Export a consistent PostgreSQL snapshot.

        await client.query(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        );

        transactionStarted = true;

        const snapshotResult = await client.query(
            "SELECT pg_export_snapshot() AS snapshot_id"
        );

        const snapshotId =
            snapshotResult.rows[0].snapshot_id;

        const tableCounts =
            await collectTableCounts(client);

        // Refuse to overwrite the backup history with
        // a snapshot that appears to have lost rows.

        if (
            previous &&
            snapshotHasShrink(previous.tableCounts, tableCounts) &&
            process.env.ALLOW_DESTRUCTIVE_BACKUP !== "true"
        ) {

            throw new Error(
                "BACKUP REFUSED: database contains fewer rows " +
                "than previous backup. Previous backup was preserved."
            );

        }

        const meta = {

            createdAt: new Date().toISOString(),

            tableCounts,

            database: "FUN",

            format: "PostgreSQL custom archive"

        };

        console.log("STARTING PG_DUMP");

        await runCommand("pg_dump", [

            "--format=custom",

            "--no-owner",

            "--no-acl",

            "--snapshot=" + snapshotId,

            "--file",
            localPath,

            "--dbname",
            DATABASE_URL

        ]);

        await client.query("COMMIT");
        transactionStarted = false;

        console.log("PG_DUMP COMPLETE");

        const fileStream = fs.createReadStream(localPath);

        const encodedMeta =
            Buffer.from(JSON.stringify(meta)).toString("base64url");

        const response = await fetch(
            BACKUP_URL + "/internal/backup",
            {

                method: "PUT",

                headers: {

                    "Content-Type": "application/octet-stream",

                    "x-backup-secret": BACKUP_SECRET,

                    "x-backup-meta": encodedMeta

                },

                body: fileStream,

                duplex: "half",

                signal: AbortSignal.timeout(30 * 60 * 1000)

            }
        );

        const responseText = await response.text();

        if (!response.ok) {

            throw new Error(
                "BACKUP SERVER ERROR: " + responseText
            );

        }

        console.log(
            "BACKUP UPLOADED:",
            responseText
        );

    } finally {

        if (transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        client.release();

        await fsp.unlink(localPath).catch(() => {});

        await pool.end();

        pool = null;

    }

}

// =====================================================
// START BACKUP SERVER
// =====================================================

async function startBackupServer() {

    if (!BACKUP_SECRET) {
        throw new Error("BACKUP_SECRET is required");
    }

    await fsp.mkdir(BACKUP_DIR, {
        recursive: true
    });

    installBackupServer();

    httpServer.listen(PORT, "0.0.0.0", () => {

        console.log("FUN BACKUP SERVER STARTED");

        console.log("PORT:", PORT);

        console.log("BACKUP DIR:", BACKUP_DIR);

        console.log("BACKUPS RETAINED:", BACKUP_KEEP);

    });

}

// =====================================================
// START PRIMARY SERVER
// =====================================================

async function startPrimaryServer() {

    pool = createPool();

    try {

        console.log("CHECKING BACKUP SERVER...");

        // Restore before initializing the database,
        // if the main database has lost tables or rows.

        await maybeRestoreFromBackup("startup");

        await initDB();

        installPrimaryRoutes();

        httpServer.listen(PORT, "0.0.0.0", () => {

            console.log("FUN MAIN SERVER STARTED");

            console.log("PORT:", PORT);

        });

        // Check the main database once per minute.

        const monitor = setInterval(async () => {

            if (restoreRunning) return;

            try {

                await maybeRestoreFromBackup("periodic check");

            } catch (err) {

                console.error("RESTORE MONITOR ERROR:", err);

            }

        }, 60 * 1000);

        monitor.unref();

    } catch (err) {

        console.error("PRIMARY START ERROR:", err);

        process.exit(1);

    }

}

// =====================================================
// START
// =====================================================

async function main() {

    console.log("FUN SERVICE ROLE:", ROLE);

    if (ROLE === "backup-server") {

        await startBackupServer();

        return;

    }

    if (ROLE === "backup-job") {

        await runBackupJob();

        console.log("BACKUP JOB FINISHED");

        return;

    }

    if (ROLE === "primary") {

        await startPrimaryServer();

        return;

    }

    throw new Error("Unknown SERVICE_ROLE: " + ROLE);

}

main().catch(err => {

    console.error("FATAL ERROR:", err);

    process.exit(1);

});

// =====================================================
// SHUTDOWN
// =====================================================

async function shutdown() {

    console.log("SHUTTING DOWN");

    if (pool) {
        await pool.end().catch(console.error);
        pool = null;
    }

    httpServer.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 10000).unref();

}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
