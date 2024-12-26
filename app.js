const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const games = {};

// Game configuration options
const DIFFICULTY_LEVELS = {
    easy: { pairs: 6, timeLimit: 180, flipTime: 2000 },
    medium: { pairs: 8, timeLimit: 150, flipTime: 1500 },
    hard: { pairs: 12, timeLimit: 120, flipTime: 1000 }
};

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const { gameId, difficulty = 'medium' } = data;
        
        if (!games[gameId]) {
            games[gameId] = {
                players: [],
                difficulty: DIFFICULTY_LEVELS[difficulty],
                cards: generateCards(DIFFICULTY_LEVELS[difficulty].pairs),
                currentTurn: 0,
                flippedCards: [],
                matches: new Set(),
                timeLeft: DIFFICULTY_LEVELS[difficulty].timeLimit,
                gameTimer: null,
                streaks: { }, // Track consecutive matches
                bonusPoints: { } // Track bonus points
            };
        }

        if (games[gameId].players.length < 2) {
            games[gameId].players.push({
                id: socket.id,
                score: 0,
                name: `Player ${games[gameId].players.length + 1}`
            });
            socket.join(gameId);
            socket.gameId = gameId;

            // Start game if we have 2 players
            if (games[gameId].players.length === 2) {
                startGame(gameId);
            }
        }
    });

    socket.on('flipCard', (data) => {
        const game = games[socket.gameId];
        if (!game || game.timeLeft <= 0) return;

        const { cardIndex } = data;
        if (game.matches.has(cardIndex)) return;
        
        game.flippedCards.push(cardIndex);

        io.to(socket.gameId).emit('cardFlipped', {
            cardIndex,
            card: game.cards[cardIndex]
        });

        if (game.flippedCards.length === 2) {
            handleMatch(socket, game);
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });
});

function handleMatch(socket, game) {
    const [first, second] = game.flippedCards;
    const isMatch = game.cards[first].value === game.cards[second].value;
    const currentPlayerIndex = game.players.findIndex(p => p.id === socket.id);
    const currentPlayer = game.players[currentPlayerIndex];

    let points = 0;
    if (isMatch) {
        // Base points
        points = 10;

        // Streak bonus
        game.streaks[currentPlayer.id] = (game.streaks[currentPlayer.id] || 0) + 1;
        if (game.streaks[currentPlayer.id] >= 3) {
            points += 5; // Bonus for 3+ consecutive matches
        }

        // Time bonus (more points for faster matches)
        const timeBonus = Math.floor(game.timeLeft / 10);
        points += timeBonus;

        game.matches.add(first);
        game.matches.add(second);
        currentPlayer.score += points;
        game.bonusPoints[currentPlayer.id] = points - 10; // Track bonus points
    } else {
        game.streaks[currentPlayer.id] = 0;
        game.currentTurn = (currentPlayerIndex + 1) % 2;
    }

    io.to(socket.gameId).emit('turnResult', {
        flippedCards: game.flippedCards,
        isMatch,
        matches: Array.from(game.matches),
        scores: game.players.map(p => p.score),
        nextTurn: game.players[game.currentTurn].id,
        points: points,
        streak: game.streaks[currentPlayer.id],
        bonusPoints: game.bonusPoints[currentPlayer.id] || 0,
        timeLeft: game.timeLeft
    });

    game.flippedCards = [];

    // Check for game end
    if (game.matches.size === game.cards.length) {
        endGame(socket.gameId);
    }
}

function startGame(gameId) {
    const game = games[gameId];
    io.to(gameId).emit('gameStart', {
        cards: game.cards,
        currentTurn: game.players[0].id,
        difficulty: game.difficulty,
        timeLimit: game.difficulty.timeLimit
    });

    // Start game timer
    game.gameTimer = setInterval(() => {
        game.timeLeft--;
        io.to(gameId).emit('timeUpdate', { timeLeft: game.timeLeft });

        if (game.timeLeft <= 0) {
            endGame(gameId);
        }
    }, 1000);
}

function endGame(gameId) {
    const game = games[gameId];
    if (!game) return;

    clearInterval(game.gameTimer);
    
    const winner = game.players.reduce((prev, current) => 
        (prev.score > current.score) ? prev : current
    );

    io.to(gameId).emit('gameEnd', {
        winner: winner.id,
        finalScores: game.players.map(p => ({
            id: p.id,
            score: p.score,
            name: p.name,
            bonusPoints: game.bonusPoints[p.id] || 0
        }))
    });
}

function generateCards(numPairs) {
    const values = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, numPairs);
    const cards = [...values, ...values].map((value) => ({ value }));
    
    // Shuffle cards
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    
    return cards;
}

function handleDisconnect(socket) {
    if (socket.gameId && games[socket.gameId]) {
        clearInterval(games[socket.gameId].gameTimer);
        io.to(socket.gameId).emit('playerDisconnected');
        delete games[socket.gameId];
    }
}

http.listen(3000, () => {
    console.log('Server running on port 3000');
});