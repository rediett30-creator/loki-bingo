const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database.js');

const BOT_TOKEN = '8743849448:AAEkLo-hSwD5S9aBn782vjchQzmwlxqoG8A';
const WEBAPP_URL = 'https://loki-bingo-production.up.railway.app/lobby';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Game state
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
    currentRound: 0,
    gameId: null
};

// Generate 500 cards
console.log('🎴 Generating 500 premium bingo cards...');
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
console.log(`✅ Generated ${gameState.cards.length} premium cards`);

// Game flow functions
function startCartelaPhase() {
    gameState.phase = 'cartela';
    gameState.cartelaTimer = 30;
    gameState.gameId = Math.random().toString(36).substring(2, 10).toUpperCase();
    gameState.prizePool = 0;
    gameState.calledNumbers = [];
    gameState.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    gameState.soldCards.clear();
    
    for (let id in gameState.players) {
        gameState.players[id].hasCard = false;
        gameState.players[id].card = null;
    }
    
    io.emit('phaseChange', 'cartela');
    io.emit('cartelaTimer', gameState.cartelaTimer);
    io.emit('gameId', gameState.gameId);
    
    if (gameState.cartelaInterval) clearInterval(gameState.cartelaInterval);
    
    gameState.cartelaInterval = setInterval(() => {
        gameState.cartelaTimer--;
        io.emit('cartelaTimer', gameState.cartelaTimer);
        
        if (gameState.cartelaTimer <= 0) {
            clearInterval(gameState.cartelaInterval);
            startGamePhase();
        }
    }, 1000);
}

function startGamePhase() {
    gameState.phase = 'game';
    gameState.currentRound++;
    gameState.calledNumbers = [];
    gameState.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    
    io.emit('phaseChange', 'game');
    io.emit('prizePool', gameState.prizePool);
    io.emit('playersCount', Object.keys(gameState.players).length);
    
    if (gameState.gameInterval) clearInterval(gameState.gameInterval);
    
    gameState.gameInterval = setInterval(() => {
        if (gameState.phase !== 'game') {
            clearInterval(gameState.gameInterval);
            return;
        }
        
        if (gameState.availableNumbers.length === 0) {
            clearInterval(gameState.gameInterval);
            startWinnerPhase('no_winner');
            return;
        }
        
        let idx = Math.floor(Math.random() * gameState.availableNumbers.length);
        let number = gameState.availableNumbers[idx];
        gameState.availableNumbers.splice(idx, 1);
        gameState.calledNumbers.push(number);
        
        io.emit('numberCalled', {
            number: number,
            called: gameState.calledNumbers,
            remaining: gameState.availableNumbers.length
        });
        
        checkForBingo();
    }, 5000);
}

function checkForBingo() {
    for (let id in gameState.players) {
        let player = gameState.players[id];
        if (player.card && player.hasCard) {
            if (checkBingoPatterns(player.card, gameState.calledNumbers)) {
                gameState.phase = 'winner';
                clearInterval(gameState.gameInterval);
                
                let commission = Math.floor(gameState.prizePool * 0.2);
                let prize = gameState.prizePool - commission;
                
                db.saveGameResult(gameState.currentRound, gameState.prizePool, id, player.name, 'BINGO!');
                
                io.emit('gameWon', {
                    name: player.name,
                    prize: prize,
                    commission: commission,
                    cartelaNumber: player.cartelaNumber
                });
                
                startWinnerPhase('winner');
                return;
            }
        }
    }
}

function checkBingoPatterns(card, calledNumbers) {
    let calledSet = new Set(calledNumbers);
    for (let r = 0; r < 5; r++) {
        if (card[r].every(cell => cell === 'FREE' || calledSet.has(cell))) return true;
    }
    for (let c = 0; c < 5; c++) {
        let win = true;
        for (let r = 0; r < 5; r++) {
            if (card[r][c] !== 'FREE' && !calledSet.has(card[r][c])) { win = false; break; }
        }
        if (win) return true;
    }
    return false;
}

function startWinnerPhase(reason) {
    gameState.phase = 'winner';
    gameState.winnerTimer = 5;
    io.emit('winnerTimer', gameState.winnerTimer);
    if (reason === 'no_winner') io.emit('noWinner');
    
    if (gameState.winnerInterval) clearInterval(gameState.winnerInterval);
    
    gameState.winnerInterval = setInterval(() => {
        gameState.winnerTimer--;
        io.emit('winnerTimer', gameState.winnerTimer);
        
        if (gameState.winnerTimer <= 0) {
            clearInterval(gameState.winnerInterval);
            startCartelaPhase();
        }
    }, 1000);
}

// Socket.IO
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    socket.on('join', async ({ playerId, playerName }) => {
        if (!gameState.players[playerId]) {
            gameState.players[playerId] = {
                name: playerName,
                card: null,
                hasCard: false,
                cartelaNumber: null,
                socketId: socket.id
            };
        }
        
        const balance = await db.getPlayerBalance(playerId, playerName);
        
        socket.emit('gameState', {
            phase: gameState.phase,
            cartelaTimer: gameState.cartelaTimer,
            winnerTimer: gameState.winnerTimer,
            prizePool: gameState.prizePool,
            calledNumbers: gameState.calledNumbers,
            calledCount: gameState.calledNumbers.length,
            playersCount: Object.keys(gameState.players).length,
            selectedCount: Object.values(gameState.players).filter(p => p.hasCard).length,
            cards: gameState.cards.slice(0, 20),
            soldCards: Array.from(gameState.soldCards),
            balance: balance,
            gameId: gameState.gameId,
            stake: 100
        });
        
        if (gameState.players[playerId].card) {
            socket.emit('yourCard', {
                card: gameState.players[playerId].card,
                cartelaNumber: gameState.players[playerId].cartelaNumber
            });
        }
    });
    
    socket.on('selectCard', async ({ playerId, cardIndex }) => {
        if (gameState.phase !== 'cartela') return;
        let player = gameState.players[playerId];
        if (!player || player.hasCard) return;
        
        let cardNumber = cardIndex + 1;
        if (gameState.soldCards.has(cardNumber)) return;
        
        const result = await db.deductBalance(playerId, 100);
        if (result.success) {
            gameState.soldCards.add(cardNumber);
            player.card = JSON.parse(JSON.stringify(gameState.cards[cardIndex]));
            player.hasCard = true;
            player.cartelaNumber = cardNumber;
            gameState.prizePool += 100;
            
            io.emit('cardSelected', {
                selectedCount: Object.values(gameState.players).filter(p => p.hasCard).length,
                prizePool: gameState.prizePool,
                soldCards: Array.from(gameState.soldCards)
            });
            
            socket.emit('yourCard', {
                card: player.card,
                cartelaNumber: cardNumber
            });
            socket.emit('balance', result.newBalance);
        }
    });
    
    socket.on('bingo', ({ playerId }) => {
        if (gameState.phase !== 'game') return;
        let player = gameState.players[playerId];
        if (!player || !player.card) return;
        if (checkBingoPatterns(player.card, gameState.calledNumbers)) {
            gameState.phase = 'winner';
            clearInterval(gameState.gameInterval);
            let commission = Math.floor(gameState.prizePool * 0.2);
            let prize = gameState.prizePool - commission;
            db.saveGameResult(gameState.currentRound, gameState.prizePool, playerId, player.name, 'BINGO!');
            io.emit('gameWon', {
                name: player.name,
                prize: prize,
                commission: commission,
                cartelaNumber: player.cartelaNumber
            });
            startWinnerPhase('winner');
        }
    });
    
    socket.on('getBalance', async ({ playerId }) => {
        const balance = await db.getPlayerBalance(playerId, '');
        socket.emit('balance', balance);
    });
});

// Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
    const name = msg.from.first_name || 'Player';
    const userId = msg.from.id.toString();
    await db.getPlayerBalance(userId, name);
    
    bot.sendMessage(msg.chat.id, 
        `🎰 **Welcome to Loki Bingo, ${name}!** 🎰\n\n` +
        `💰 Main Wallet: 0 ETB\n` +
        `🎮 Play Wallet: 1250 ETB\n\n` +
        `👇 Click below to enter the lobby!`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎲 ENTER LOBBY', web_app: { url: `${WEBAPP_URL}` } }
                ]]
            }
        }
    );
});

bot.onText(/\/balance/, async (msg) => {
    const userId = msg.from.id.toString();
    const balance = await db.getPlayerBalance(userId, msg.from.first_name);
    bot.sendMessage(msg.chat.id, 
        `💰 **Your Balance:**\n` +
        `🎮 Play Wallet: ${balance} coins`,
        { parse_mode: 'Markdown' }
    );
});

bot.on('polling_error', (error) => {});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/lobby', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start game
startCartelaPhase();

server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🔥 PREMIUM LOKI BINGO - BETTER THAN DIL BINGO');
    console.log('='.repeat(50));
    console.log(`📱 Port: ${PORT}`);
    console.log(`🎴 500 premium cards ready`);
    console.log('='.repeat(50));
});