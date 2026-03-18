const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// ===== YOUR CREDENTIALS - DO NOT CHANGE =====
const BOT_TOKEN = '8743849448:AAEkLo-hSwD5S9aBn782vjchQzmwlxqoG8A';
// This will be updated after deployment
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://YOUR-APP-NAME.up.railway.app/lobby';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: ["https://telegram.org", "https://*.telegram.org", "*"],
        credentials: true 
    } 
});

// Simple middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== BALANCE DATABASE =====
let userBalances = {};

// ===== GAME STATE =====
let gameState = {
    phase: 'cartela',
    cartelaTimer: 30,
    winnerTimer: 5,
    prizePool: 0,
    calledNumbers: [],
    availableNumbers: [],
    players: {},
    cards: [],
    soldCards: new Set()
};

// ===== GENERATE 500 CARDS =====
console.log('🎴 Generating 500 bingo cards...');
for (let i = 0; i < 500; i++) {
    let card = [];
    for (let row = 0; row < 5; row++) {
        let rowData = [];
        for (let col = 0; col < 5; col++) {
            if (row === 2 && col === 2) {
                rowData.push('FREE');
            } else {
                let min = [1, 16, 31, 46, 61][col];
                let max = [15, 30, 45, 60, 75][col];
                let num;
                do {
                    num = Math.floor(Math.random() * (max - min + 1)) + min;
                } while (card.some(r => r[col] === num));
                rowData.push(num);
            }
        }
        card.push(rowData);
    }
    gameState.cards.push(card);
}
console.log(`✅ Generated ${gameState.cards.length} cards`);

// ===== GAME TIMERS =====
setInterval(() => {
    if (gameState.phase === 'cartela') {
        gameState.cartelaTimer--;
        io.emit('cartelaTimer', gameState.cartelaTimer);
        
        if (gameState.cartelaTimer <= 0) {
            console.log('🎮 Moving to GAME phase');
            gameState.phase = 'game';
            gameState.calledNumbers = [];
            gameState.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
            io.emit('phaseChange', 'game');
            io.emit('prizePool', gameState.prizePool);
        }
    }
    
    if (gameState.phase === 'winner') {
        gameState.winnerTimer--;
        io.emit('winnerTimer', gameState.winnerTimer);
        
        if (gameState.winnerTimer <= 0) {
            console.log('🔄 New round starting');
            gameState.phase = 'cartela';
            gameState.cartelaTimer = 30;
            gameState.winnerTimer = 5;
            gameState.prizePool = 0;
            gameState.calledNumbers = [];
            gameState.soldCards.clear();
            
            for (let id in gameState.players) {
                gameState.players[id].hasCard = false;
                gameState.players[id].card = null;
            }
            io.emit('phaseChange', 'cartela');
            io.emit('cartelaTimer', 30);
        }
    }
}, 1000);

// ===== NUMBER CALLING =====
setInterval(() => {
    if (gameState.phase === 'game' && gameState.availableNumbers.length > 0) {
        let idx = Math.floor(Math.random() * gameState.availableNumbers.length);
        let number = gameState.availableNumbers[idx];
        gameState.availableNumbers.splice(idx, 1);
        gameState.calledNumbers.push(number);
        
        io.emit('numberCalled', {
            number: number,
            called: gameState.calledNumbers
        });
        
        // Check for bingo
        for (let id in gameState.players) {
            let player = gameState.players[id];
            if (player.card && player.hasCard) {
                if (checkBingo(player.card, gameState.calledNumbers)) {
                    console.log(`🏆 WINNER: ${player.name}`);
                    gameState.phase = 'winner';
                    let commission = Math.floor(gameState.prizePool * 0.2);
                    let prize = gameState.prizePool - commission;
                    
                    if (userBalances[id]) {
                        userBalances[id] += prize;
                    }
                    
                    io.emit('gameWon', {
                        name: player.name,
                        prize: prize,
                        commission: commission
                    });
                    break;
                }
            }
        }
    }
}, 3000);

// ===== CHECK BINGO =====
function checkBingo(card, calledNumbers) {
    let calledSet = new Set(calledNumbers);
    
    for (let r = 0; r < 5; r++) {
        if (card[r].every(cell => cell === 'FREE' || calledSet.has(cell))) {
            return true;
        }
    }
    
    for (let c = 0; c < 5; c++) {
        let win = true;
        for (let r = 0; r < 5; r++) {
            if (card[r][c] !== 'FREE' && !calledSet.has(card[r][c])) {
                win = false;
                break;
            }
        }
        if (win) return true;
    }
    
    return false;
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    socket.on('join', ({ playerId, playerName }) => {
        if (!gameState.players[playerId]) {
            gameState.players[playerId] = {
                name: playerName,
                card: null,
                hasCard: false,
                socketId: socket.id
            };
        }
        
        if (!userBalances[playerId]) {
            userBalances[playerId] = 1250;
        }
        
        socket.emit('gameState', {
            phase: gameState.phase,
            cartelaTimer: gameState.cartelaTimer,
            winnerTimer: gameState.winnerTimer,
            prizePool: gameState.prizePool,
            calledNumbers: gameState.calledNumbers,
            playerCount: Object.keys(gameState.players).length,
            selectedCount: Object.values(gameState.players).filter(p => p.hasCard).length,
            cards: gameState.cards.slice(0, 20),
            soldCards: Array.from(gameState.soldCards)
        });
        
        if (gameState.players[playerId].card) {
            socket.emit('yourCard', gameState.players[playerId].card);
        }
    });
    
    socket.on('selectCard', ({ playerId, cardIndex }) => {
        if (gameState.phase !== 'cartela') return;
        
        let player = gameState.players[playerId];
        if (!player || player.hasCard) return;
        
        let cardNumber = cardIndex + 1;
        if (gameState.soldCards.has(cardNumber)) return;
        
        gameState.soldCards.add(cardNumber);
        player.card = JSON.parse(JSON.stringify(gameState.cards[cardIndex]));
        player.hasCard = true;
        gameState.prizePool += 100;
        
        io.emit('cardSelected', {
            selectedCount: Object.values(gameState.players).filter(p => p.hasCard).length,
            prizePool: gameState.prizePool,
            soldCards: Array.from(gameState.soldCards)
        });
        
        socket.emit('yourCard', player.card);
    });
    
    socket.on('bingo', ({ playerId }) => {
        if (gameState.phase !== 'game') return;
        
        let player = gameState.players[playerId];
        if (!player || !player.card) return;
        
        if (checkBingo(player.card, gameState.calledNumbers)) {
            gameState.phase = 'winner';
            let commission = Math.floor(gameState.prizePool * 0.2);
            let prize = gameState.prizePool - commission;
            
            if (userBalances[playerId]) {
                userBalances[playerId] += prize;
            }
            
            io.emit('gameWon', {
                name: player.name,
                prize: prize,
                commission: commission
            });
        }
    });
    
    socket.on('getBalance', ({ playerId }) => {
        socket.emit('balance', userBalances[playerId] || 1250);
    });
    
    socket.on('deductBalance', ({ playerId, amount }) => {
        if (userBalances[playerId] && userBalances[playerId] >= amount) {
            userBalances[playerId] -= amount;
            socket.emit('balance', userBalances[playerId]);
            return true;
        }
        return false;
    });
});

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
    const name = msg.from.first_name || 'Player';
    
    bot.sendMessage(msg.chat.id, 
        `🎰 **Welcome to Loki Bingo, ${name}!** 🎰\n\n` +
        `👇 Click below to enter the lobby!`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎲 ENTER LOBBY', web_app: { url: WEBAPP_URL } }
                ]]
            }
        }
    );
});

bot.on('polling_error', (error) => {
    console.log('Polling error (ignore):', error.message);
});

// ===== ROUTES =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/lobby', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/winner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'winner.html'));
});

// Health check for cloud platforms
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ===== START SERVER =====
server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('✅ LOKI BINGO - CLOUD READY');
    console.log('='.repeat(50));
    console.log(`📱 Port: ${PORT}`);
    console.log(`🎴 500 cards ready`);
    console.log('='.repeat(50));
});