const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database.js');

// ===== YOUR CREDENTIALS =====
const BOT_TOKEN = '8743849448:AAG7ShQ0CWsrcFVXVnWUL3H8mgQXp2m_oas';
const WEBAPP_URL = 'https://loki-bingo-production.up.railway.app/lobby';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: ["https://telegram.org", "https://*.telegram.org", "*"],
        credentials: true 
    } 
});

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    soldCards: new Set(),
    currentRound: 0
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
            gameState.currentRound++;
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
                    
                    // Save to database with YOUR 20% commission!
                    db.saveGameResult(
                        gameState.currentRound,
                        gameState.prizePool,
                        id,
                        player.name,
                        'BINGO!'
                    );
                    
                    io.emit('gameWon', {
                        name: player.name,
                        prize: gameState.prizePool - Math.floor(gameState.prizePool * 0.2),
                        commission: Math.floor(gameState.prizePool * 0.2)
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
    
    socket.on('join', async ({ playerId, playerName }) => {
        if (!gameState.players[playerId]) {
            gameState.players[playerId] = {
                name: playerName,
                card: null,
                hasCard: false,
                socketId: socket.id
            };
        }
        
        // Get balance from DATABASE (permanent!)
        const balance = await db.getPlayerBalance(playerId, playerName);
        
        socket.emit('gameState', {
            phase: gameState.phase,
            cartelaTimer: gameState.cartelaTimer,
            winnerTimer: gameState.winnerTimer,
            prizePool: gameState.prizePool,
            calledNumbers: gameState.calledNumbers,
            playerCount: Object.keys(gameState.players).length,
            selectedCount: Object.values(gameState.players).filter(p => p.hasCard).length,
            cards: gameState.cards.slice(0, 20),
            soldCards: Array.from(gameState.soldCards),
            balance: balance
        });
        
        if (gameState.players[playerId].card) {
            socket.emit('yourCard', gameState.players[playerId].card);
        }
    });
    
    socket.on('selectCard', async ({ playerId, cardIndex }) => {
        if (gameState.phase !== 'cartela') return;
        
        let player = gameState.players[playerId];
        if (!player || player.hasCard) return;
        
        let cardNumber = cardIndex + 1;
        if (gameState.soldCards.has(cardNumber)) return;
        
        // Deduct from DATABASE
        const result = await db.deductBalance(playerId, 100);
        
        if (result.success) {
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
            socket.emit('balance', result.newBalance);
        }
    });
    
    socket.on('getBalance', async ({ playerId }) => {
        const balance = await db.getPlayerBalance(playerId, '');
        socket.emit('balance', balance);
    });
    
    socket.on('deductBalance', async ({ playerId, amount }) => {
        const result = await db.deductBalance(playerId, amount);
        if (result.success) {
            socket.emit('balance', result.newBalance);
        }
    });
});

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
    const name = msg.from.first_name || 'Player';
    const userId = msg.from.id.toString();
    
    // Get or create player in database
    await db.getPlayerBalance(userId, name);
    
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

// ===== YOUR EARNINGS COMMAND =====
bot.onText(/\/earnings/, async (msg) => {
    // Only you can use this (your ID: 5514445301)
    if (msg.from.id.toString() !== '5514445301') return;
    
    const total = await db.getTotalCommissions();
    const recent = await db.getRecentGames(5);
    
    let message = `💰 **YOUR TOTAL EARNINGS: ${total} coins**\n\n`;
    message += `📊 **Recent Games:**\n`;
    
    recent.forEach(game => {
        message += `• ${game.winner_name} won ${game.prize_pool} - You got ${game.commission}\n`;
    });
    
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// ===== BALANCE CHECK COMMAND =====
bot.onText(/\/balance/, async (msg) => {
    const userId = msg.from.id.toString();
    const balance = await db.getPlayerBalance(userId, msg.from.first_name);
    
    bot.sendMessage(msg.chat.id, 
        `💰 **Your Balance: ${balance} coins**`,
        { parse_mode: 'Markdown' }
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

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ===== START SERVER =====
server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('✅ LOKI BINGO WITH PERMANENT DATABASE');
    console.log('='.repeat(50));
    console.log(`📱 Port: ${PORT}`);
    console.log(`🎴 500 cards ready`);
    console.log(`💰 Your commissions are now PERMANENT!`);
    console.log('='.repeat(50));
});