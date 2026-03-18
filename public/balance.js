// Simple balance management - for future expansion
let userBalances = {};

function getUserBalance(userId) {
    if (!userBalances[userId]) {
        userBalances[userId] = 1250;
    }
    return userBalances[userId];
}

function deductBalance(userId, amount) {
    if (userBalances[userId] >= amount) {
        userBalances[userId] -= amount;
        return true;
    }
    return false;
}

function addBalance(userId, amount) {
    userBalances[userId] += amount;
}