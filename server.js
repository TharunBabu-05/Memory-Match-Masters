const emojiCategories = {
    animals: ['🐶', '🐱', '🐼', '🦊', '🦁', '🐯', '🐨', '🐮', '🐷', '🐸', '🦄', '🦓', '🦒', '🦘', '🦬', '🦣'],
    birds:   ['🦅', '🦜', '🦢', '🦩', '🦚', '🦃', '🦉', '🦤', '🦆', '🦢', '🕊️', '🐧', '🐦', '🦅', '🦃', '🦢'],
    space:   ['🚀', '🛸', '🌍', '🌙', '⭐', '🌠', '☄️', '🌌', '🌑', '🛰️', '🪐', '🌞', '🌛', '🌜', '🌏', '🌪️'],
    flowers: ['🌸', '🌺', '🌹', '🌷', '🌻', '🌼', '💐', '🌾', '🌿', '🍀', '🪴', '🌵', '🌴', '🌳', '🌲', '🍁']
};

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        transports: ['websocket', 'polling'],
        credentials: true
    },
    allowEIO3: true
});
const path = require('path');
const port = process.env.PORT || 3000;
http.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});

// Serve static files from public directory
app.use(express.static('public'));

// Store active games
const games = {};

// Generate random game ID
function generateGameId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate cards for the game

function generateCards(difficulty, category) {
    // Make sure we're using the correct category
    console.log('Generating cards for category:', category); // Debug log
    
    // Default to 'flowers' if no category is specified
    const emojis = emojiCategories[category || 'flowers'];
    
    const pairs = {
        'easy': 6,
        'medium': 8,
        'hard': 12
    }[difficulty] || 8;

    // Take only the number of emojis we need based on difficulty
    const selectedEmojis = emojis.slice(0, pairs);
    
    // Create pairs and shuffle
    const cards = [...selectedEmojis, ...selectedEmojis]
        .sort(() => Math.random() - 0.5)
        .map((value, index) => ({ value, index }));
    
    console.log('Generated cards:', cards); // Debug log
    return cards;
}


function handleCardFlip(socket, game, cardIndex) {
    // Don't allow flipping if:
    // 1. Card is already matched
    // 2. It's not player's turn
    // 3. Card is already flipped
    if (game.matches.has(cardIndex) || 
        game.players[game.currentTurn].id !== socket.id ||
        game.flippedCards.includes(cardIndex)) {
        return;
    }
    
    game.flippedCards.push(cardIndex);
    
    // Emit the card flip to all players
    io.to(socket.gameId).emit('cardFlipped', {
        cardIndex,
        card: game.cards[cardIndex]
    });
    
    // Check for match when two cards are flipped
    if (game.flippedCards.length === 2) {
        const [first, second] = game.flippedCards;
        const isMatch = game.cards[first].value === game.cards[second].value;
        
        if (isMatch) {
            // Add cards to matches set
            game.matches.add(first);
            game.matches.add(second);
            
            // Update score and streak for current player
            const currentPlayerIndex = game.currentTurn;
            game.players[currentPlayerIndex].score++;
            game.players[currentPlayerIndex].streak = (game.players[currentPlayerIndex].streak || 0) + 1;
            
            // Calculate bonus points for streaks
            const streak = game.players[currentPlayerIndex].streak;
            const bonusPoints = streak >= 3 ? Math.floor(streak * 0.5) : 0;
            
            // Keep turn for the same player on match
            io.to(socket.gameId).emit('turnResult', {
                flippedCards: [first, second],
                isMatch: true,
                matches: Array.from(game.matches),
                scores: game.players.map(p => p.score),
                nextTurn: game.players[game.currentTurn].id,
                streak: streak,
                bonusPoints: bonusPoints
            });
        } else {
            // Reset streak on mismatch
            game.players[game.currentTurn].streak = 0;
            
            // Switch turns on mismatch
            game.currentTurn = (game.currentTurn + 1) % 2;
            
            io.to(socket.gameId).emit('turnResult', {
                flippedCards: game.flippedCards,
                isMatch: false,
                matches: Array.from(game.matches),
                scores: game.players.map(p => p.score),
                nextTurn: game.players[game.currentTurn].id,
                streak: 0,
                bonusPoints: 0
            });
        }
        
        // Reset flipped cards
        game.flippedCards = [];

        // Check if game should end
        if (game.matches.size === game.cards.length) {
            endGame(socket.gameId);
        }
    }
}
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    
    socket.on('joinGame', ({ gameId, difficulty, category }) => {
        console.log('Join game request:', { gameId, difficulty, category }); // Debug log
        
        let game = games[gameId];

        if (!game) {
            // Create new game with explicitly passed category
            game = {
                id: gameId,
                players: [],
                cards: generateCards(difficulty, category),
                matches: new Set(),
                flippedCards: [],
                currentTurn: 0,
                timeLeft: difficulty === 'easy' ? 180 : difficulty === 'hard' ? 300 : 240,
                category: category // Store the category
            };
            games[gameId] = game;
        }
        if (game.players.length >= 2) {
            socket.emit('gameFull');
            return;
        }

        // Join the game room
        socket.join(gameId);
        socket.gameId = gameId;
        game.players.push({
            id: socket.id,
            score: 0,
            streak: 0
        });

        // Start game when 2 players join
        if (game.players.length === 2) {
            startGame(gameId);
        } else {
            socket.emit('waitingForPlayer');
        }
    });

    socket.on('createGame', ({ difficulty }) => {
        const gameId = generateGameId();
        socket.emit('gameCreated', { gameId });
    });

    socket.on('flipCard', (data) => {
        const game = games[socket.gameId];
        if (!game) return;

        handleCardFlip(socket, game, data.cardIndex);
    });

    socket.on('disconnect', () => {
        const gameId = socket.gameId;
        if (gameId && games[gameId]) {
            io.to(gameId).emit('playerDisconnected');
            delete games[gameId];
        }
    });
});

function startGame(gameId) {
    const game = games[gameId];
    if (!game) return;

    // Start game timer
    game.timer = setInterval(() => {
        game.timeLeft--;
        io.to(gameId).emit('timeUpdate', { timeLeft: game.timeLeft });

        if (game.timeLeft <= 0 || game.matches.size === game.cards.length) {
            endGame(gameId);
        }
    }, 1000);

    // Emit game start event
    io.to(gameId).emit('gameStart', {
        cards: game.cards,
        currentTurn: game.players[0].id
    });
}

function endGame(gameId) {
    const game = games[gameId];
    if (!game) return;

    clearInterval(game.timer);
    
    // Calculate final scores and determine winner
    const finalScores = game.players.map(player => ({
        name: `Player ${game.players.indexOf(player) + 1}`,
        score: player.score,
        bonusPoints: player.streak >= 3 ? Math.floor(player.streak * 0.5) : 0
    }));

    const winner = game.players.reduce((prev, current) => 
        (current.score > prev.score) ? current : prev
    ).id;

    io.to(gameId).emit('gameEnd', {
        winner,
        finalScores
    });

    delete games[gameId];
}

// Start server
http.listen(port, () => {
    console.log(`Server running on port ${port}`);
});