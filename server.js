const { WebSocketServer } = require('ws');

// Render (and most hosts) assign the port via an env var at runtime.
// Falls back to 8080 for local testing.
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
console.log(`Multiplayer game server running on port ${PORT}`);

// Store all active (joined) players
const players = {};

const COLORS = ['#3FBA54', '#4E66E4', '#F35F53', '#F3C553', '#40dda4', '#ff8340', '#c8b745', '#8C9688'];

// ---------- World / biome geometry ----------
// Must match the client's constants (client.js) exactly, or the visual map,
// food placement, and water-bar biome checks will all disagree with what
// players actually see on screen.
const GRID_SIZE = 82;
const GRID_COUNT = 245; // 245x245 grid cells
const WORLD_W = GRID_SIZE * GRID_COUNT;
const WORLD_H = GRID_SIZE * GRID_COUNT;
const OCEAN_GRID_WIDTH = 90;   // right ocean band width, in grid cells
const ARCTIC_GRID_HEIGHT = 40; // top arctic band height, in grid cells
const SAND_GRID_WIDTH = 3;     // beach/sand transition band width, in grid cells

function getBiomeRect(biome) {
    const oceanWidthPx = OCEAN_GRID_WIDTH * GRID_SIZE;
    const oceanX = WORLD_W - oceanWidthPx;
    const sandPx = GRID_SIZE * SAND_GRID_WIDTH;
    const sandX = oceanX - sandPx;
    const arcticHeightPx = ARCTIC_GRID_HEIGHT * GRID_SIZE;

    if (biome === 'arctic') {
        return { x0: 0, y0: 0, x1: WORLD_W, y1: arcticHeightPx };
    } else if (biome === 'ocean') {
        return { x0: oceanX, y0: arcticHeightPx, x1: WORLD_W, y1: WORLD_H };
    }
    return { x0: 0, y0: arcticHeightPx, x1: sandX, y1: WORLD_H }; // land
}

function pointBiome(x, y) {
    const arctic = getBiomeRect('arctic');
    if (y >= arctic.y0 && y <= arctic.y1) return 'arctic';
    const ocean = getBiomeRect('ocean');
    if (x >= ocean.x0) return 'ocean';
    return 'land';
}

const BIOME_SPAWN_MARGIN = 140; // kept clear of the jagged biome edges, mirrors the client's spawn picker

function getBiomeSpawnPoint(biome) {
    const rect = getBiomeRect(biome);
    const m = BIOME_SPAWN_MARGIN;
    let minX = rect.x0 + m, maxX = rect.x1 - m, minY = rect.y0 + m, maxY = rect.y1 - m;
    if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }
    if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
    return {
        x: minX + Math.random() * (maxX - minX),
        y: minY + Math.random() * (maxY - minY)
    };
}

// ---------- Tier progression ----------
const XP_THRESHOLDS = [15, 24, 38, 61, 98, 157, 252, 403, 644, 1031, 1649, 2639, 4222, 6755, 10809];
const BASE_RADIUS = 20;
const RADIUS_PER_TIER = 3.2;

const TIERS = {
    land: ['mouse', 'rabbit', 'fox', 'pig', 'deer', 'cheetah', 'lion', 'gorilla', 'bear', 'croc', 'rhino', 'dragon', 'blackdragon'],
    ocean: ['shrimp', 'seahorse', 'crab', 'turtle', 'stingray', 'octopus', 'squid', 'swordfish', 'shark', 'killerwhale', 'kraken'],
    arctic: ['chipmunk', 'lemming', 'arctichare', 'arcticfox', 'penguin', 'seal', 'muskox', 'reindeer', 'wolf', 'wolverine', 'snowleopard', 'walrus', 'polarbear', 'mammoth', 'yeti']
};
const STARTER_SPECIES = ['mouse', 'shrimp', 'chipmunk'];
const STARTER_TRACK = { mouse: 'land', shrimp: 'ocean', chipmunk: 'arctic' };

function xpForNextTier(tierIndex) {
    return XP_THRESHOLDS[Math.min(tierIndex, XP_THRESHOLDS.length - 1)];
}

function applyTier(player, track, tierIndex) {
    const list = TIERS[track];
    tierIndex = Math.max(0, Math.min(list.length - 1, tierIndex));
    player.track = track;
    player.tierIndex = tierIndex;
    player.species = list[tierIndex];
    player.radius = BASE_RADIUS + tierIndex * RADIUS_PER_TIER;
}

// Returns true if anything changed (so callers know whether to broadcast).
function updateTierFromXp(player) {
    const list = TIERS[player.track];
    if (!list) return false;
    const before = player.tierIndex;
    while (player.tierIndex < list.length - 1 && player.xp >= xpForNextTier(player.tierIndex)) {
        applyTier(player, player.track, player.tierIndex + 1);
    }
    while (player.tierIndex > 0 && player.xp < xpForNextTier(player.tierIndex - 1)) {
        applyTier(player, player.track, player.tierIndex - 1);
    }
    return player.tierIndex !== before;
}

// ---------- Food ----------
const FOOD_TYPES = {
    land: [
        { id: 'berry', radius: 9, xpMin: 1, xpMax: 4, water: 0, weight: 6 },
        { id: 'mushroom', radius: 12, xpMin: 10, xpMax: 35, water: 0, weight: 2 },
        { id: 'watermelon', radius: 17, xpMin: 180, xpMax: 320, water: 3, weight: 1 }
    ],
    ocean: [
        { id: 'seaweed', radius: 10, xpMin: 2, xpMax: 6, water: 2, weight: 5 },
        { id: 'kelp', radius: 15, xpMin: 20, xpMax: 50, water: 5, weight: 2 },
        { id: 'waterberry', radius: 9, xpMin: 0, xpMax: 0, water: 6, weight: 3 }
    ],
    arctic: [
        { id: 'berry', radius: 9, xpMin: 1, xpMax: 4, water: 0, weight: 6 },
        { id: 'redmushroom', radius: 12, xpMin: 12, xpMax: 40, water: 0, weight: 2 }
    ]
};
const FOOD_PER_BIOME = 55;
const foodItems = {}; // id -> {id, biome, typeId, x, y, radius, xpMin, xpMax, water}
let foodIdCounter = 1;

function pickFoodType(biome) {
    const types = FOOD_TYPES[biome];
    let totalWeight = 0;
    for (const t of types) totalWeight += t.weight;
    let r = Math.random() * totalWeight;
    for (const t of types) {
        r -= t.weight;
        if (r <= 0) return t;
    }
    return types[types.length - 1];
}

function randomPointInBiome(biome) {
    const rect = getBiomeRect(biome);
    const m = GRID_SIZE * 2;
    let minX = rect.x0 + m, maxX = rect.x1 - m, minY = rect.y0 + m, maxY = rect.y1 - m;
    if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }
    if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
    return { x: minX + Math.random() * (maxX - minX), y: minY + Math.random() * (maxY - minY) };
}

function spawnFoodItem(biome) {
    const type = pickFoodType(biome);
    const pos = randomPointInBiome(biome);
    const id = foodIdCounter++;
    const food = {
        id,
        biome,
        typeId: type.id,
        x: pos.x,
        y: pos.y,
        radius: type.radius * (0.8 + Math.random() * 0.4),
        xpMin: type.xpMin,
        xpMax: type.xpMax,
        water: type.water
    };
    foodItems[id] = food;
    broadcast({ type: 'foodSpawned', food });
    return food;
}

function ensureFoodStocked() {
    ['land', 'ocean', 'arctic'].forEach((biome) => {
        let count = 0;
        for (const id in foodItems) if (foodItems[id].biome === biome) count++;
        while (count < FOOD_PER_BIOME) { spawnFoodItem(biome); count++; }
    });
}

function eatFood(player, food) {
    delete foodItems[food.id];
    const xpGain = food.xpMin + Math.random() * (food.xpMax - food.xpMin);
    player.xp = (player.xp || 0) + xpGain;
    if (food.water) player.water = Math.min(100, (player.water == null ? 100 : player.water) + food.water * 8);
    updateTierFromXp(player);
    broadcast({ type: 'foodEaten', id: food.id, by: player.id });
    broadcastPlayerStats(player);
}

function checkFoodCollisions(player) {
    for (const id in foodItems) {
        const f = foodItems[id];
        const dx = player.x - f.x, dy = player.y - f.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (player.radius || BASE_RADIUS) + f.radius) {
            eatFood(player, f);
        }
    }
}

function broadcastPlayerStats(player) {
    broadcast({
        type: 'playerStats',
        id: player.id,
        xp: player.xp,
        tierIndex: player.tierIndex,
        species: player.species,
        radius: player.radius,
        water: player.water
    });
}

// ---------- Live player count ----------
// Broadcast to every connected socket (joined or not), so the server-list
// dropdown on the start menu can show a real number before anyone presses
// Play, not just once they've joined.
function broadcastPlayerCount() {
    const count = Object.keys(players).length;
    broadcast({ type: 'playerCount', count });
}

wss.on('connection', (socket) => {
    // Generate a unique identifier for the connecting player
    const playerId = Math.random().toString(36).substring(2, 9);
    socket.playerId = playerId;
    console.log(`Socket connected: ${playerId}`);

    // Let this socket know the current player count right away, even
    // before it joins - this is what makes the start-menu count live.
    socket.send(JSON.stringify({ type: 'playerCount', count: Object.keys(players).length }));

    socket.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (err) {
            console.error('Error processing network packet:', err);
            return;
        }

        // A player only "exists" in the game world once they've sent a join
        // message (i.e. pressed Play with a name). This lets the socket open
        // instantly (so the client can show the Play button) without
        // spawning a player before they've actually chosen to play.
        if (data.type === 'join') {
            const name = (data.name || 'Player').toString().slice(0, 15) || 'Player';
            const species = STARTER_SPECIES.includes(data.species) ? data.species : 'mouse';
            const track = STARTER_TRACK[species];
            const spawnPoint = getBiomeSpawnPoint(track);

            const player = {
                id: playerId,
                x: spawnPoint.x,
                y: spawnPoint.y,
                name,
                color: COLORS[Math.floor(Math.random() * COLORS.length)],
                xp: 0,
                water: 100
            };
            applyTier(player, track, 0);
            players[playerId] = player;

            // Tell the joining player who they are, the world size, who's
            // already playing, and the current food layout.
            socket.send(JSON.stringify({
                type: 'init',
                id: playerId,
                world: { width: WORLD_W, height: WORLD_H },
                currentPlayers: players,
                foodItems: Object.values(foodItems)
            }));

            // Let everyone else know a new player joined
            broadcast({
                type: 'newPlayer',
                id: playerId,
                playerData: player
            }, playerId);

            broadcastPlayerCount();
            console.log(`Player joined: ${name} (${playerId}) as ${species}`);
            return;
        }

        if (data.type === 'move' && players[playerId]) {
            const x = Math.max(0, Math.min(WORLD_W, Number(data.x) || 0));
            const y = Math.max(0, Math.min(WORLD_H, Number(data.y) || 0));
            players[playerId].x = x;
            players[playerId].y = y;

            broadcast({
                type: 'update',
                id: playerId,
                x,
                y
            }, playerId);

            checkFoodCollisions(players[playerId]);
        }
    });

    // Handle sudden player disconnects or closed tabs
    socket.on('close', () => {
        if (players[playerId]) {
            console.log(`Player disconnected: ${players[playerId].name} (${playerId})`);
            delete players[playerId];
            broadcast({ type: 'playerLeft', id: playerId });
            broadcastPlayerCount();
        }
    });
});

// ---------- Game tick ----------
// Water bar drain/refill is time-based (not just movement-triggered), so it
// needs its own loop: figure out each player's current biome, drain or
// refill their water, apply a slow XP penalty (and possible downgrade) if
// an ocean-track player is stranded dry, and broadcast whatever changed.
const TICK_MS = 500;
setInterval(() => {
    const dtSeconds = TICK_MS / 1000;
    for (const id in players) {
        const player = players[id];
        if (player.track !== 'ocean') continue;
        if (player.water == null) player.water = 100;

        const biome = pointBiome(player.x, player.y);
        const before = { water: player.water, xp: player.xp, tierIndex: player.tierIndex };

        if (biome === 'ocean') {
            player.water = Math.min(100, player.water + dtSeconds * 18);
        } else {
            player.water = Math.max(0, player.water - dtSeconds * 4.5);
            if (player.water <= 0) {
                player.xp = Math.max(0, (player.xp || 0) - dtSeconds * 40);
                updateTierFromXp(player);
            }
        }

        if (before.water !== player.water || before.xp !== player.xp || before.tierIndex !== player.tierIndex) {
            broadcastPlayerStats(player);
        }
    }

    ensureFoodStocked();
}, TICK_MS);

ensureFoodStocked();

// Helper function to broadcast a data payload to all connected clients,
// optionally skipping the player who triggered the update
function broadcast(data, excludeId = null) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.playerId !== excludeId) {
            client.send(payload);
        }
    });
}
