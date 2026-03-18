const TelegramBot = require('node-telegram-bot-api');

// Put your bot token here
const token = '8743849448:AAEkLo-hSwD5S9aBn782vjchQzmwlxqoG8A';

console.log('🤖 Testing bot connection...');

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
    console.log('✅ /start received from:', msg.from.first_name);
    bot.sendMessage(msg.chat.id, '✅ Bot is working!')
        .then(() => console.log('✅ Message sent'))
        .catch(err => console.log('❌ Send error:', err.message));
});

bot.on('polling_error', (err) => {
    console.log('⚠️ Polling error:', err.message);
});

console.log('🤖 Bot started. Send /start to your bot in Telegram.');