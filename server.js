const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = new Map();

function createInitialBoard(playerCount) {
    const board = [];
    const cellsPerPlayer = 36 / playerCount;

    for (let player = 0; player < playerCount; player++) {
        for (let i = 0; i < cellsPerPlayer; i++) {
            board.push(player);
        }
    }

    for (let i = board.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [board[i], board[j]] = [board[j], board[i]];
    }

    return board;
}

io.on('connection', (socket) => {
    console.log('사용자 연결:', socket.id);

    socket.on('createRoom', ({ maxPlayers = 2 }) => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        const initialBoard = createInitialBoard(maxPlayers);

        rooms.set(roomCode, {
            board: initialBoard,
            players: [socket.id],
            clicks: { [socket.id]: 0 },
            gameStarted: false,
            gameEnded: false,
            timer: null,
            maxPlayers: maxPlayers
        });

        socket.join(roomCode);
        socket.emit('roomCreated', {
            roomCode,
            board: initialBoard,
            playerNumber: 1,
            maxPlayers: maxPlayers
        });

        console.log(`방 생성됨: ${roomCode} (${maxPlayers}인용)`);
    });

    socket.on('joinRoom', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '존재하지 않는 방입니다.');
            return;
        }

        if (room.players.length >= room.maxPlayers) {
            socket.emit('error', '방이 가득 찼습니다.');
            return;
        }

        const playerNumber = room.players.length + 1;
        room.players.push(socket.id);
        room.clicks[socket.id] = 0;
        socket.join(roomCode);

        socket.emit('roomJoined', {
            roomCode,
            board: room.board,
            playerNumber: playerNumber,
            maxPlayers: room.maxPlayers
        });

        io.to(roomCode).emit('playerCountUpdate', {
            currentPlayers: room.players.length,
            maxPlayers: room.maxPlayers
        });

        console.log(`${socket.id}가 방 ${roomCode}에 참가 (${room.players.length}/${room.maxPlayers})`);
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '방을 찾을 수 없습니다.');
            return;
        }

        if (room.players.length < room.maxPlayers) {
            socket.emit('error', `${room.maxPlayers}명이 모두 참가해야 합니다.`);
            return;
        }

        if (room.gameStarted) {
            socket.emit('error', '이미 게임이 시작되었습니다.');
            return;
        }

        room.gameStarted = true;
        room.gameEnded = false;
        io.to(roomCode).emit('gameStarted');

        console.log(`방 ${roomCode}: 게임 시작`);

        room.timer = setTimeout(() => {
            endGame(roomCode);
        }, 30000);
    });

    socket.on('flipCell', ({ roomCode, index }) => {
        const room = rooms.get(roomCode);

        if (!room || !room.gameStarted || room.gameEnded) return;

        room.board[index] = (room.board[index] + 1) % room.maxPlayers;
        room.clicks[socket.id]++;

        // 먼저 보드 업데이트를 모든 클라이언트에 전송
        io.to(roomCode).emit('boardUpdate', {
            board: room.board,
            clickedIndex: index,
            clicks: room.clicks
        });

        console.log(`방 ${roomCode}: 칸 ${index} 뒤집힘`);

        // 올킬 체크
        const colorCounts = getColorCounts(room.board, room.maxPlayers);
        if (colorCounts.some(count => count === 36)) {
            console.log(`🔥 올킬 발생! 방 ${roomCode}`);

            // 타이머 즉시 정리
            if (room.timer) {
                clearTimeout(room.timer);
                room.timer = null;
            }

            // 게임 즉시 종료
            endGame(roomCode, true);
        }
    });

    function getColorCounts(board, maxPlayers) {
        const counts = Array(maxPlayers).fill(0);
        board.forEach(cell => {
            if (cell >= 0 && cell < maxPlayers) {
                counts[cell]++;
            }
        });
        return counts;
    }

    function endGame(roomCode, isAllKill = false) {
        const room = rooms.get(roomCode);

        // 방이 없거나 이미 종료된 경우 무시
        if (!room) {
            console.log(`[endGame] 방을 찾을 수 없음: ${roomCode}`);
            return;
        }

        if (room.gameEnded) {
            console.log(`[endGame] 이미 종료된 게임: ${roomCode}`);
            return;
        }

        // 게임 종료 플래그 즉시 설정
        room.gameEnded = true;
        room.gameStarted = false;

        // 타이머 확실히 제거
        if (room.timer) {
            clearTimeout(room.timer);
            room.timer = null;
        }

        const colorCounts = getColorCounts(room.board, room.maxPlayers);
        const scores = room.players.map((playerId, index) => ({
            playerNumber: index + 1,
            score: colorCounts[index],
            clicks: room.clicks[playerId] || 0
        }));

        const maxScore = Math.max(...scores.map(s => s.score));
        const winners = scores.filter(s => s.score === maxScore);

        let winner;
        if (winners.length === 1) {
            winner = winners[0].playerNumber;
        } else {
            const minClicks = Math.min(...winners.map(w => w.clicks));
            const finalWinner = winners.find(w => w.clicks === minClicks);
            winner = finalWinner ? finalWinner.playerNumber : 'tie';
        }

        const gameOverData = {
            winner,
            scores,
            winType: isAllKill ? 'allkill' : 'normal'
        };

        console.log(`[Room ${roomCode}] 🎮 게임 종료 데이터:`, gameOverData);
        console.log(`[Room ${roomCode}] 📡 전송 대상 플레이어: ${room.players.length}명`);

        // 각 플레이어에게 개별적으로 전송 (확실한 전달 보장)
        room.players.forEach(playerId => {
            io.to(playerId).emit('gameOver', gameOverData);
            console.log(`[Room ${roomCode}] ✅ gameOver 전송 완료: ${playerId}`);
        });

        // 추가로 방 전체에도 전송 (이중 보장)
        io.to(roomCode).emit('gameOver', gameOverData);

        console.log(`[Room ${roomCode}] 🏁 게임 종료 완료! 승자: ${winner}, 올킬: ${isAllKill}`);
    }

    socket.on('rematch', (roomCode) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        if (room.timer) {
            clearTimeout(room.timer);
            room.timer = null;
        }

        room.board = createInitialBoard(room.maxPlayers);
        room.clicks = {};
        room.players.forEach(playerId => {
            room.clicks[playerId] = 0;
        });
        room.gameStarted = false;
        room.gameEnded = false;

        io.to(roomCode).emit('rematchStarted', {
            board: room.board
        });

        console.log(`방 ${roomCode}: 재대결 시작`);
    });

    socket.on('disconnect', () => {
        console.log('사용자 연결 해제:', socket.id);

        for (const [roomCode, room] of rooms.entries()) {
            if (room.players.includes(socket.id)) {
                if (room.timer) clearTimeout(room.timer);

                if (!room.gameEnded) {
                    socket.to(roomCode).emit('opponentLeft');
                }

                rooms.delete(roomCode);
                console.log(`방 ${roomCode} 삭제됨`);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
