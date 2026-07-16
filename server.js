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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query("SELECT NOW()", (err, result) => {
    if(err){
        console.log("POSTGRES ERROR:", err);
    } else {
        console.log("POSTGRES CONNECTED:", result.rows[0]);
    }
});

// ================= DATABASE INIT =================

async function initDB(){

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            nickname TEXT UNIQUE,
            password TEXT,
            clan INTEGER
        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS saves(
            userId INTEGER PRIMARY KEY REFERENCES users(id),

            coins INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,

            playerColor TEXT DEFAULT '#ff0000',

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

            invincible INTEGER DEFAULT 0,
            invincibleTimer INTEGER DEFAULT 0,

            freezeHit INTEGER DEFAULT 0,

            shield INTEGER DEFAULT 0,
            shieldTimer INTEGER DEFAULT 0
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS clans(
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            owner INTEGER REFERENCES users(id),
            created TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS clan INTEGER
    `);

    await pool.query(`
        ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_clan_fkey
    `);

    await pool.query(`
        ALTER TABLE users
        ADD CONSTRAINT users_clan_fkey
        FOREIGN KEY (clan)
        REFERENCES clans(id)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS clan_requests(
            id SERIAL PRIMARY KEY,
            clan INTEGER REFERENCES clans(id) ON DELETE CASCADE,
            userId INTEGER REFERENCES users(id) ON DELETE CASCADE,
            created TIMESTAMP DEFAULT NOW(),
            UNIQUE(clan,userId)
        )
    `);

    console.log("POSTGRES TABLES READY");
}

// ================= AUTH =================

function auth(req,res,next){

    const token = req.headers.authorization;

    console.log("AUTH TOKEN:", token);

    if(!token){
        return res.status(401).json({
            error:"No token"
        });
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

app.post("/register", async (req,res)=>{

    const {nickname,password}=req.body;

    if(!nickname || !password){
        return res.json({error:"empty fields"});
    }

    try{

        const hash = await bcrypt.hash(password,10);

        const user = await pool.query(
            `
            INSERT INTO users(nickname,password)
            VALUES($1,$2)
            RETURNING id
            `,
            [nickname,hash]
        );

        const id = user.rows[0].id;


        await pool.query(
            `
            INSERT INTO saves(userId)
            VALUES($1)
            `,
            [id]
        );


        res.json({
            success:true,
            id,
            nickname
        });


    }catch(e){

        console.log(e);

        res.json({
            error:"user exists"
        });

    }

});


app.post("/login", async (req,res)=>{

    const {nickname,password}=req.body;

    try{

        const result = await pool.query(
            "SELECT * FROM users WHERE nickname=$1",
            [nickname]
        );

        const user = result.rows[0];

        if(!user){
            return res.json({
                error:"not user found"
            });
        }

        const ok = await bcrypt.compare(
            password,
            user.password
        );

        if(!ok){
            return res.json({
                error:"wrong password"
            });
        }


        const token = jwt.sign(
            {id:user.id},
            SECRET,
            {expiresIn:"7d"}
        );


        res.json({
            token,
            id:user.id,
            nickname:user.nickname
        });


    }catch(e){

        console.log(e);

        res.status(500).json({
            error:e.message
        });

    }

});

app.delete("/account", auth, async(req,res)=>{

    try{

        await pool.query(
            "DELETE FROM saves WHERE userid=$1",
            [req.userId]
        );

        await pool.query(
            "DELETE FROM users WHERE id=$1",
            [req.userId]
        );


        res.json({
            success:true
        });


    }catch(e){

        res.status(500).json({
            error:e.message
        });

    }

});

app.post("/clan/create", auth, async (req, res) => {

    const { name } = req.body;

    try{

        const user = await pool.query(
            "SELECT clan FROM users WHERE id=$1",
            [req.userId]
        );

        if(user.rows[0].clan){
            return res.json({
                success:false,
                error:"Вы уже состоите в клане"
            });
        }

        const clan = await pool.query(
            "INSERT INTO clans(name,owner) VALUES($1,$2) RETURNING id",
            [name, req.userId]
        );

        await pool.query(
            "UPDATE users SET clan=$1 WHERE id=$2",
            [clan.rows[0].id, req.userId]
        );

        res.json({success:true});

    }catch(e){

        res.json({
            success:false,
            error:e.message
        });

    }

});

app.get("/clans", async (req,res)=>{

    const result = await pool.query(`
        SELECT
            clans.id,
            clans.name,
            clans.owner,

            COUNT(users.id) AS members,

            COALESCE(
                json_agg(
                    json_build_object(
                        'id', users.id,
                        'nickname', users.nickname
                    )
                ) FILTER (WHERE users.id IS NOT NULL),
                '[]'
            ) AS players

        FROM clans

        LEFT JOIN users
        ON users.clan = clans.id

        GROUP BY clans.id

        ORDER BY members DESC
    `);

    res.json(result.rows);

});

app.post("/clan/join", auth, async(req,res)=>{

    const clanId = req.body.id;


    const user = await pool.query(
        "SELECT clan FROM users WHERE id=$1",
        [req.userId]
    );


    if(user.rows[0].clan){

        return res.json({
            success:false,
            message:"Вы уже в клане"
        });

    }


    const clan = await pool.query(
        "SELECT id FROM clans WHERE id=$1",
        [clanId]
    );


    if(clan.rows.length === 0){

        return res.json({
            success:false,
            message:"Клан не найден"
        });

    }


    await pool.query(
        `
        INSERT INTO clan_requests(clan,userId)
        VALUES($1,$2)
        ON CONFLICT DO NOTHING
        `,
        [
            clanId,
            req.userId
        ]
    );


    res.json({
        success:true,
        message:"Заявка отправлена"
    });


});

app.post("/clan/leave", auth, async (req, res) => {

    const user = await pool.query(
        "SELECT clan FROM users WHERE id=$1",
        [req.userId]
    );

    if (!user.rows[0].clan) {
        return res.json({
            success: false,
            message: "Вы не состоите в клане"
        });
    }

    const clan = await pool.query(
        "SELECT owner FROM clans WHERE id=$1",
        [user.rows[0].clan]
    );

    if (Number(clan.rows[0].owner) === Number(req.userId)) {
        return res.json({
            success: false,
            message: "Владелец должен удалить клан."
        });
    }

    await pool.query(
        "UPDATE users SET clan=NULL WHERE id=$1",
        [req.userId]
    );

    res.json({
        success: true,
        message: "Вы покинули клан."
    });

});

app.get("/clan/me", auth, async (req, res) => {

    const user = await pool.query(
        "SELECT clan FROM users WHERE id=$1",
        [req.userId]
    );

    if (!user.rows[0].clan) {
        return res.json({
            inClan: false
        });
    }

    const clan = await pool.query(
        "SELECT owner,name FROM clans WHERE id=$1",
        [user.rows[0].clan]
    );

    res.json({
        inClan: true,
        clanId: user.rows[0].clan,
        clanName: clan.rows[0].name,
        owner: Number(clan.rows[0].owner) === Number(req.userId)
    });

});

app.delete("/clan/delete", auth, async (req, res) => {

    const user = await pool.query(
        "SELECT clan FROM users WHERE id=$1",
        [req.userId]
    );

    if (!user.rows[0].clan) {
        return res.json({
            success:false,
            message:"Вы не состоите в клане."
        });
    }

    const clanId = user.rows[0].clan;


    const clan = await pool.query(
        "SELECT owner FROM clans WHERE id=$1",
        [clanId]
    );


    if (Number(clan.rows[0].owner) !== Number(req.userId)) {
        return res.json({
            success:false,
            message:"Удалить клан может только владелец."
        });
    }


    // вернуть 500 монет владельцу
    await pool.query(
        `
        UPDATE saves
        SET coins = coins + 500
        WHERE userId=$1
        `,
        [req.userId]
    );


    // убрать игроков из клана
    await pool.query(
        "UPDATE users SET clan=NULL WHERE clan=$1",
        [clanId]
    );


    // удалить клан
    await pool.query(
        "DELETE FROM clans WHERE id=$1",
        [clanId]
    );


    res.json({
        success:true,
        message:"Клан удалён. 500 монет возвращено."
    });

});

app.get("/clan/requests", auth, async(req,res)=>{


    const result = await pool.query(`

        SELECT
        clan_requests.id,
        users.nickname,
        users.id AS userid

        FROM clan_requests

        JOIN clans
        ON clans.id = clan_requests.clan

        JOIN users
        ON users.id = clan_requests.userid

        WHERE clans.owner=$1

        `,
        [
            req.userId
        ]
    );


    res.json(result.rows);


});

app.get("/debug/requests", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                clan_requests.*,
                users.nickname,
                clans.name AS clan_name
            FROM clan_requests
            JOIN users ON users.id = clan_requests.userId
            JOIN clans ON clans.id = clan_requests.clan
        `);

        res.json(result.rows);

    } catch (e) {
        res.json({
            error: e.message
        });
    }
});

app.post("/clan/request/accept", auth, async(req,res)=>{


const requestId = req.body.id;


const request = await pool.query(
`
SELECT *
FROM clan_requests
WHERE id=$1
`,
[
requestId
]);


if(request.rows.length===0){

return res.json({
success:false,
message:"Заявка не найдена"
});

}



const data=request.rows[0];



const owner = await pool.query(
`
SELECT owner
FROM clans
WHERE id=$1
`,
[
data.clan
]);



if(Number(owner.rows[0].owner)!==Number(req.userId)){

return res.json({
success:false,
message:"Нет прав"
});

}



await pool.query(
`
UPDATE users
SET clan=$1
WHERE id=$2
`,
[
data.clan,
data.userid
]);



await pool.query(
`
DELETE FROM clan_requests
WHERE id=$1
`,
[
requestId
]);



res.json({
success:true
});


});

app.post("/clan/request/reject", auth, async(req,res)=>{


const request = await pool.query(`
SELECT 
clan_requests.clan,
clans.owner

FROM clan_requests

JOIN clans
ON clans.id = clan_requests.clan

WHERE clan_requests.id=$1
`,
[
req.body.id
]);


if(request.rows.length===0){
    return res.json({
        success:false,
        message:"Заявка не найдена"
    });
}


if(Number(request.rows[0].owner)!==Number(req.userId)){
    return res.json({
        success:false,
        message:"Нет прав"
    });
}


await pool.query(
`
DELETE FROM clan_requests
WHERE id=$1
`,
[
req.body.id
]
);


res.json({
success:true
});


});

// ================= SAVE =================

app.post("/save", auth, async(req,res)=>{

    const data=req.body;

    try{

        await pool.query(
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
            nerfPrice
        )
        VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19
        )

        ON CONFLICT(userId)
        DO UPDATE SET

            coins=EXCLUDED.coins,
            level=EXCLUDED.level,
            playerColor=EXCLUDED.playerColor,

            playerSpeed=EXCLUDED.playerSpeed,
            playerPower=EXCLUDED.playerPower,

            attackCooldown=EXCLUDED.attackCooldown,
            attackRange=EXCLUDED.attackRange,

            enemyPowerNerf=EXCLUDED.enemyPowerNerf,

            speedPrice=EXCLUDED.speedPrice,
            powerPrice=EXCLUDED.powerPrice,
            attackSpeedPrice=EXCLUDED.attackSpeedPrice,
            attackRangePrice=EXCLUDED.attackRangePrice,
            nerfPrice=EXCLUDED.nerfPrice
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
            data.invincible ? 1:0,
            data.invincibleTimer,
            data.freezeHit ? 1:0,
            data.shield ? 1:0,
            data.shieldTimer
        ]);

        res.json({
            success:true
        });


    }catch(e){

        console.log(e);

        res.status(500).json({
            error:e.message
        });

    }

});

// ================= LOAD =================

app.post("/load", auth, async(req,res)=>{

    try{

        const result = await pool.query(
            "SELECT * FROM saves WHERE userid=$1",
            [req.userId]
        );


        if(result.rows.length === 0){

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


        const row = result.rows[0];


        res.json({

            coins: row.coins,
            level: row.level,

            playerColor: row.playercolor,

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

            invincible: row.invincible,
            invincibleTimer: row.invincibletimer,

            freezeHit: row.freezehit,

            shield: row.shield,
            shieldTimer: row.shieldtimer

        });


    }catch(e){

        console.log("LOAD ERROR:",e);

        res.status(500).json({
            error:e.message
        });

    }

});

app.get("/player/:query", (req, res) => {

    const query = req.params.query;

    console.log("SEARCH QUERY:", query);

    pool.query(
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

        WHERE users.id = $1
        OR users.nickname = $2
        `,
        [Number(query) || -1, query],
        (err, result) => {

            console.log("SQL ERROR:",err);
            console.log("SQL ROW:",result.rows);


            if(err){
                return res.status(500).json({
                    success:false,
                    error:err.message
                });
            }
        
        
            const row = result.rows[0];
        
        
            if(!row){
                return res.json({
                    success:false,
                    message:"No row"
                });
            }
        
        
            res.json({
                success:true,
                ...row
            });
        
        }
    );

});

app.get("/debug/users", async(req,res)=>{

try{

const result=await pool.query(
"SELECT id,nickname FROM users"
);

res.json(result.rows);

}catch(e){

res.json({
error:e.message
});

}

});

app.get("/debug/saves", async(req,res)=>{

try{

const result=await pool.query(
"SELECT * FROM saves"
);

res.json(result.rows);

}catch(e){

res.json({
error:e.message
});

}

});

app.get("/debug/player/:id", async(req,res)=>{

try{

const user = await pool.query(
"SELECT * FROM users WHERE id=$1",
[req.params.id]
);


const save = await pool.query(
"SELECT * FROM saves WHERE userid=$1",
[req.params.id]
);


res.json({
    user:user.rows[0],
    save:save.rows[0]
});


}catch(e){

res.json({
    error:e.message
});

}

});

app.post("/fixsave/:id", async (req,res)=>{

    try{

        const result = await pool.query(
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
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(userId) DO NOTHING
            RETURNING userId
            `,
            [
                Number(req.params.id),
                0,
                1,
                "#ff0000",
                6,
                100,
                800,
                50
            ]
        );


        res.json({
            success:true,
            id:Number(req.params.id)
        });


    }catch(e){

        console.log("FIXSAVE ERROR:",e);

        res.json({
            success:false,
            error:e.message
        });

    }

});

app.get("/fixdatabase", async(req,res)=>{

    try{

        await pool.query(`
            UPDATE saves
            SET
                enemypowernerf = 1,
                speedprice = 100,
                powerprice = 200,
                attackspeedprice = 250,
                attackrangeprice = 250,
                nerfprice = 300,
                invincibletimer = 0,
                shieldtimer = 0
            WHERE enemypowernerf IS NULL
        `);

        res.json({
            success:true
        });

    }catch(e){

        console.log(e);

        res.json({
            success:false,
            error:e.message
        });

    }

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

initDB().then(()=>{

    server.listen(PORT,"0.0.0.0",()=>{

        console.log(
            `Server running on port ${PORT}`
        );

    });

});
