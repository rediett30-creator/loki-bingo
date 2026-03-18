const express = require('express');
const path = require('path');

const app = express();
const PORT = 3001; // Different port to test

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.send('Server is working! <a href="/lobby">Go to Lobby</a>');
});

app.get('/lobby', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Test server running at http://localhost:${PORT}`);
    console.log(`📱 Lobby at: http://localhost:${PORT}/lobby`);
});