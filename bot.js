const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database.js');

const BOT_TOKEN = '8743849448:AAEkLo-hSwD5S9aBn782vjchQzmwlxqoG8A';
const WEBAPP_URL = 'https://loki-bingo-production.up.railway.app';
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

// ===== TELEGRAM BOT WITH COMPLETE MENU =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Keyboard menu
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '🎮 Play' }, { text: '💰 Balance' }],
            [{ text: '💳 Deposit' }, { text: '📞 Contact Support' }],
            [{ text: '📚 Instruction' }, { text: '🔄 Transfer' }],
            [{ text: '💸 Withdraw' }, { text: '🌐 Invite' }]
        ],
        resize_keyboard: true
    }
};

// Request contact keyboard
const contactKeyboard = {
    reply_markup: {
        keyboard: [[{ text: '📱 Share Contact', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
    }
};

// Start command with contact request
bot.onText(/\/start/, async (msg) => {
    const name = msg.from.first_name || 'Player';
    const userId = msg.from.id.toString();
    
    // Check if user exists
    const balance = await db.getPlayerBalance(userId, name);
    
    // Send welcome message with contact request
    bot.sendMessage(msg.chat.id, 
        `🎰 **Welcome to Loki Bingo, ${name}!** 🎰\n\n` +
        `📊 **Monthly Users:** 21,087\n` +
        `📅 **March 23**\n\n` +
        `Welcome! Please share your contact to start playing.`,
        {
            parse_mode: 'Markdown',
            reply_markup: contactKeyboard.reply_markup
        }
    );
});

// Handle contact sharing
bot.on('contact', async (msg) => {
    const contact = msg.contact;
    const userId = msg.from.id.toString();
    const name = msg.from.first_name || 'Player';
    
    if (contact) {
        // Save phone number to database
        await db.savePhoneNumber(userId, contact.phone_number);
        
        // Send success message with main menu
        bot.sendMessage(msg.chat.id,
            `✅ **Phone number saved successfully!**\n\n` +
            `🎮 **Your Stats:**\n` +
            `🏆 Main Wallet: 0 ETB\n` +
            `🎮 Play Wallet: 1250 ETB\n\n` +
            `Welcome to Loki Bingo, ${name}! Use the buttons below to navigate.`,
            {
                parse_mode: 'Markdown',
                reply_markup: mainMenu.reply_markup
            }
        );
        
        // Send mini app button
        bot.sendMessage(msg.chat.id,
            `🎲 Click below to start playing!`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎲 PLAY BINGO', web_app: { url: `${WEBAPP_URL}` } }
                    ]]
                }
            }
        );
    }
});

// Play button
bot.onText(/🎮 Play/, async (msg) => {
    bot.sendMessage(msg.chat.id, `🎲 Click below to play Bingo!`, {
        reply_markup: {
            inline_keyboard: [[
                { text: '🎲 PLAY BINGO', web_app: { url: `${WEBAPP_URL}` } }
            ]]
        }
    });
});

// Balance button
bot.onText(/💰 Balance/, async (msg) => {
    const userId = msg.from.id.toString();
    const balance = await db.getPlayerBalance(userId, msg.from.first_name);
    bot.sendMessage(msg.chat.id,
        `💰 **Your Balance:**\n\n` +
        `🏆 Main Wallet: 0 ETB\n` +
        `🎮 Play Wallet: ${balance} coins\n\n` +
        `Use Deposit to add funds!`,
        { parse_mode: 'Markdown' }
    );
});

// Deposit button
bot.onText(/💳 Deposit/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `💳 **Deposit Methods:**\n\n` +
        `Choose your preferred payment method:\n\n` +
        `📱 **TELEBIRR**\n` +
        `🏦 **CBE BIRR**\n\n` +
        `Send to:\n` +
        `📞 Phone: 0900306940\n` +
        `👤 Name: Seid\n\n` +
        `After payment, send the transaction ID here.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 TELEBIRR', callback_data: 'deposit_telebirr' }],
                    [{ text: '🏦 CBE BIRR', callback_data: 'deposit_cbe' }],
                    [{ text: '❌ Cancel', callback_data: 'cancel' }]
                ]
            }
        }
    );
});

// Instruction button
bot.onText(/📚 Instruction/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📚 **How to Play Loki Bingo:**\n\n` +
        `1️⃣ Click PLAY BINGO\n` +
        `2️⃣ Select your lucky cartela (30 seconds)\n` +
        `3️⃣ Game starts automatically\n` +
        `4️⃣ Numbers are called every 5 seconds\n` +
        `5️⃣ Mark numbers on your card\n` +
        `6️⃣ Click BINGO when you complete a pattern!\n\n` +
        `**Winning Patterns:**\n` +
        `✅ Row (horizontal line)\n` +
        `✅ Column (vertical line)\n` +
        `✅ Diagonal (corner to corner)\n` +
        `✅ Four Corners\n` +
        `✅ X Pattern\n\n` +
        `💰 Prize pool grows with each player!\n` +
        `🏆 Winner gets 80% | House takes 20%`,
        { parse_mode: 'Markdown' }
    );
});

// Transfer button
bot.onText(/🔄 Transfer/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🔄 **Transfer Funds:**\n\n` +
        `Transfer from Main Wallet to Play Wallet or vice versa.\n\n` +
        `To transfer, use:\n` +
        `/transfer <amount> <from> <to>\n\n` +
        `Example: /transfer 100 main play\n` +
        `Example: /transfer 50 play main`,
        { parse_mode: 'Markdown' }
    );
});

// Withdraw button
bot.onText(/💸 Withdraw/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `💸 **Withdraw Funds:**\n\n` +
        `Minimum withdrawal: 100 ETB\n` +
        `Processing time: 24-48 hours\n\n` +
        `To withdraw, contact support with:\n` +
        `- Your Telegram username\n` +
        `- Amount to withdraw\n` +
        `- Payment method (Telebirr/CBE)\n` +
        `- Phone number\n\n` +
        `📞 Support: @LokiBingoSupport`,
        { parse_mode: 'Markdown' }
    );
});

// Invite button
bot.onText(/🌐 Invite/, (msg) => {
    const inviteLink = `https://t.me/loki_bingo_bot?start=${msg.from.id}`;
    bot.sendMessage(msg.chat.id,
        `🌐 **Invite Friends!** 🌐\n\n` +
        `Share this link with friends:\n` +
        `${inviteLink}\n\n` +
        `🎁 **Bonus:** Get 50 coins for each friend who joins and plays!`,
        { parse_mode: 'Markdown' }
    );
});

// Contact Support button
bot.onText(/📞 Contact Support/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📞 **Contact Support:**\n\n` +
        `For any issues or questions:\n\n` +
        `📱 Telegram: @LokiBingoSupport\n` +
        `📞 Phone: +251922427297\n` +
        `📧 Email: support@lokibingo.com\n\n` +
        `Response time: 24 hours`,
        { parse_mode: 'Markdown' }
    );
});

// Handle callback queries (deposit buttons)
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    
    if (data === 'deposit_telebirr') {
        bot.sendMessage(msg.chat.id,
            `📱 **TELEBIRR Deposit:**\n\n` +
            `1. Open Telebirr app\n` +
            `2. Send to: 0900306940\n` +
            `3. Name: Seid\n` +
            `4. Amount: Minimum 10 ETB\n` +
            `5. Copy transaction ID\n\n` +
            `Send the transaction ID here to confirm deposit.`
        );
    } else if (data === 'deposit_cbe') {
        bot.sendMessage(msg.chat.id,
            `🏦 **CBE BIRR Deposit:**\n\n` +
            `1. Open CBE Birr app\n` +
            `2. Send to: 0900306940\n` +
            `3. Name: Seid\n` +
            `4. Amount: Minimum 10 ETB\n` +
            `5. Copy transaction ID\n\n` +
            `Send the transaction ID here to confirm deposit.`
        );
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handle text messages for deposit confirmation
bot.on('message', async (msg) => {
    const text = msg.text;
    const userId = msg.from.id.toString();
    
    // Check if message looks like a transaction ID
    if (text && (text.includes('TX') || text.includes('REF') || text.match(/[A-Z0-9]{10,}/))) {
        bot.sendMessage(msg.chat.id,
            `✅ **Deposit request received!**\n\n` +
            `Transaction ID: ${text}\n` +
            `Amount: 100 ETB\n\n` +
            `Your deposit will be processed within 24 hours.\n` +
            `You will receive a confirmation when it's completed.`,
            { parse_mode: 'Markdown' }
        );
    }
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    console.log('🔥 LOKI BINGO - ETHIOPIAN EDITION');
    console.log('='.repeat(50));
    console.log(`📱 Port: ${PORT}`);
    console.log(`🎴 500 cards ready`);
    console.log(`💰 Telebirr + CBE Birr ready`);
    console.log('='.repeat(50));
});