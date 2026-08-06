const { WebSocketServer } = require('ws');

// Render (and most hosts) assign the port via an env var at runtime.
// Falls back to 8080 for local testing.
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
console.log(`Multiplayer game server running on port ${PORT}`);

// Store all active (joined) players
const players = {};

const COLORS = ['#3FBA54', '#4E66E4', '#F35F53', '#F3C553', '#40dda4', '#ff8340', '#c8b745', '#8C9688'];
const WORLD_W = 3000;
const WORLD_H = 3000;

wss.on('connection', (socket) => {
    // Generate a unique identifier for the connecting player
    const playerId = Math.random().toString(36).substring(2, 9);
    socket.playerId = playerId;
    console.log(`Socket connected: ${playerId}`);

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
            players[playerId] = {
                x: Math.random() * WORLD_W,
                y: Math.random() * WORLD_H,
                name,
                color: COLORS[Math.floor(Math.random() * COLORS.length)],
                radius: 20
            };

            // Tell the joining player who they are, the world size, and who's already playing
            socket.send(JSON.stringify({
                type: 'init',
                id: playerId,
                world: { width: WORLD_W, height: WORLD_H },
                currentPlayers: players
            }));

            // Let everyone else know a new player joined
            broadcast({
                type: 'newPlayer',
                id: playerId,
                playerData: players[playerId]
            }, playerId);

            console.log(`Player joined: ${name} (${playerId})`);
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
        }
    });

    // Handle sudden player disconnects or closed tabs
    socket.on('close', () => {
        if (players[playerId]) {
            console.log(`Player disconnected: ${players[playerId].name} (${playerId})`);
            delete players[playerId];
            broadcast({ type: 'playerLeft', id: playerId });
        }
    });
});

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
