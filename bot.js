const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database.js');

// ===== YOUR CREDENTIALS =====
const BOT_TOKEN = '8743849448:AAEkLo-hSwD5S9aBn782vjchQzmwlxqoG8A';
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
    phase: 'cartela',           // 'cartela', 'game', 'winner'
    cartelaTimer: 30,
    gameTimer: 0,
    winnerTimer: 5,
    prizePool: 0,
    calledNumbers: [],
    availableNumbers: [],
    players: {},
    cards: [],
    soldCards: new Set(),
    currentRound: 0,
    gameInterval: null,
    cartelaInterval: null,
    winnerInterval: null,
    allNumbersCalled: false
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

// ===== START CARTELA PHASE =====
function startCartelaPhase() {
    console.log('🔄 Starting CARTELA phase');
    gameState.phase = 'cartela';
    gameState.cartelaTimer = 30;
    gameState.prizePool = 0;
    gameState.calledNumbers = [];
    gameState.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    gameState.soldCards.clear();
    gameState.allNumbersCalled = false;
    
    // Reset players
    for (let id in gameState.players) {
        gameState.players[id].hasCard = false;
        gameState.players[id].card = null;
    }
    
    io.emit('phaseChange', 'cartela');
    io.emit('cartelaTimer', gameState.cartelaTimer);
    
    // Clear any existing intervals
    if (gameState.cartelaInterval) clearInterval(gameState.cartelaInterval);
    if (gameState.gameInterval) clearInterval(gameState.gameInterval);
    if (gameState.winnerInterval) clearInterval(gameState.winnerInterval);
    
    // Start cartela countdown
    gameState.cartelaInterval = setInterval(() => {
        gameState.cartelaTimer--;
        io.emit('cartelaTimer', gameState.cartelaTimer);
        
        if (gameState.cartelaTimer <= 0) {
            clearInterval(gameState.cartelaInterval);
            startGamePhase();
        }
    }, 1000);
}

// ===== START GAME PHASE =====
function startGamePhase() {
    console.log('🎮 Starting GAME phase');
    gameState.phase = 'game';
    gameState.currentRound++;
    gameState.calledNumbers = [];
    gameState.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    gameState.allNumbersCalled = false;
    
    io.emit('phaseChange', 'game');
    io.emit('prizePool', gameState.prizePool);
    
    // Start calling numbers every 5 seconds
    gameState.gameInterval = setInterval(() => {
        if (gameState.phase !== 'game') {
            clearInterval(gameState.gameInterval);
            return;
        }
        
        // Check if all numbers have been called
        if (gameState.availableNumbers.length === 0) {
            console.log('📢 All numbers called - No winner this round');
            gameState.allNumbersCalled = true;
            clearInterval(gameState.gameInterval);
            startWinnerPhase('no_winner');
            return;
        }
        
        // Call next number
        let idx = Math.floor(Math.random() * gameState.availableNumbers.length);
        let number = gameState.availableNumbers[idx];
        gameState.availableNumbers.splice(idx, 1);
        gameState.calledNumbers.push(number);
        
        console.log(`🔢 Number called: ${number} (${gameState.calledNumbers.length}/75)`);
        io.emit('numberCalled', {
            number: number,
            called: gameState.calledNumbers
        });
        
        // Check for bingo after each number
        checkForBingo();
        
    }, 5000); // 5 seconds between numbers
}

// ===== CHECK FOR BINGO =====
function checkForBingo() {
    for (let id in gameState.players) {
        let player = gameState.players[id];
        if (player.card && player.hasCard) {
            if (checkBingoPatterns(player.card, gameState.calledNumbers)) {
                console.log(`🏆 WINNER FOUND: ${player.name}`);
                gameState.phase = 'winner';
                clearInterval(gameState.gameInterval);
                
                let commission = Math.floor(gameState.prizePool * 0.2);
                let prize = gameState.prizePool - commission;
                
                // Save to database
                db.saveGameResult(
                    gameState.currentRound,
                    gameState.prizePool,
                    id,
                    player.name,
                    'BINGO!'
                );
                
                io.emit('gameWon', {
                    name: player.name,
                    prize: prize,
                    commission: commission
                });
                
                startWinnerPhase('winner');
                return;
            }
        }
    }
}

// ===== CHECK BINGO PATTERNS =====
function checkBingoPatterns(card, calledNumbers) {
    let calledSet = new Set(calledNumbers);
    
    // Check rows
    for (let r = 0; r < 5; r++) {
        if (card[r].every(cell => cell === 'FREE' || calledSet.has(cell))) {
            return true;
        }
    }
    
    // Check columns
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
    
    // Check diagonals
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
        if (card[i][i] !== 'FREE' && !calledSet.has(card[i][i])) d1 = false;
        if (card[i][4-i] !== 'FREE' && !calledSet.has(card[i][4-i])) d2 = false;
    }
    if (d1 || d2) return true;
    
    return false;
}

// ===== START WINNER PHASE =====
function startWinnerPhase(reason) {
    console.log(`🏁 Starting WINNER phase (reason: ${reason})`);
    gameState.phase = 'winner';
    gameState.winnerTimer = 5;
    
    if (reason === 'no_winner') {
        io.emit('noWinner', { message: 'No winner this round!' });
    }
    
    io.emit('winnerTimer', gameState.winnerTimer);
    
    // Start winner countdown
    gameState.winnerInterval = setInterval(() => {
        gameState.winnerTimer--;
        io.emit('winnerTimer', gameState.winnerTimer);
        
        if (gameState.winnerTimer <= 0) {
            clearInterval(gameState.winnerInterval);
            startCartelaPhase(); // Go back to cartela for new round
        }
    }, 1000);
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
        
        // Get balance from database
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
        
        // Deduct from database
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
    
    socket.on('bingo', ({ playerId }) => {
        if (gameState.phase !== 'game') return;
        
        let player = gameState.players[playerId];
        if (!player || !player.card) return;
        
        if (checkBingoPatterns(player.card, gameState.calledNumbers)) {
            gameState.phase = 'winner';
            clearInterval(gameState.gameInterval);
            
            let commission = Math.floor(gameState.prizePool * 0.2);
            let prize = gameState.prizePool - commission;
            
            db.saveGameResult(
                gameState.currentRound,
                gameState.prizePool,
                playerId,
                player.name,
                'BINGO!'
            );
            
            io.emit('gameWon', {
                name: player.name,
                prize: prize,
                commission: commission
            });
            
            startWinnerPhase('winner');
        }
    });
    
    socket.on('getBalance', async ({ playerId }) => {
        const balance = await db.getPlayerBalance(playerId, '');
        socket.emit('balance', balance);
    });
});

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
    const name = msg.from.first_name || 'Player';
    const userId = msg.from.id.toString();
    
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

// ===== EARNINGS COMMAND =====
bot.onText(/\/earnings/, async (msg) => {
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

// ===== BALANCE COMMAND =====
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

// ===== START GAME =====
startCartelaPhase();

// ===== START SERVER =====
server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('✅ LOKI BINGO - COMPLETE GAME FLOW');
    console.log('='.repeat(50));
    console.log(`📱 Port: ${PORT}`);
    console.log(`🎴 500 cards ready`);
    console.log(`🔄 Flow: Cartela(30s) → Game(5s intervals) → Winner(5s) → Cartela`);
    console.log(`💰 Your commissions are now PERMANENT!`);
    console.log('='.repeat(50));
});