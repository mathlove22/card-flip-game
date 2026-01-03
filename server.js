const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 정적 파일 제공
app.use(express.static('public'));

// 게임 방 관리
const rooms = new Map();

// 초기 보드 생성 함수 (18:18 균등)
function createInitialBoard() {
    const board = [];
    // 18개 빨강(0), 18개 파랑(1)
    for (let i = 0; i < 18; i++) {
        board.push(0); // 빨강
        board.push(1); // 파랑
    }
    // 랜덤 섞기
    for (let i = board.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [board[i], board[j]] = [board[j], board[i]];
    }
    return board;
}

io.on('connection', (socket) => {
    console.log('사용자 연결:', socket.id);

    // 방 생성
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        // 초기 보드 생성 (18:18)
        const initialBoard = createInitialBoard();

        rooms.set(roomCode, {
            board: initialBoard,
            players: [socket.id],
            clicks: { [socket.id]: 0 },
            gameStarted: false,
            timer: null
        });

        socket.join(roomCode);
        socket.emit('roomCreated', {
            roomCode,
            board: initialBoard,
            playerNumber: 1
        });

        console.log(`방 생성됨: ${roomCode}`);
    });

    // 방 참가
    socket.on('joinRoom', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '존재하지 않는 방입니다.');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('error', '방이 가득 찼습니다.');
            return;
        }

        room.players.push(socket.id);
        room.clicks[socket.id] = 0;
        socket.join(roomCode);

        socket.emit('roomJoined', {
            roomCode,
            board: room.board,
            playerNumber: 2
        });

        // 상대방에게 알림
        socket.to(roomCode).emit('opponentJoined');

        // 두 명 다 참가
        io.to(roomCode).emit('bothPlayersReady');

        console.log(`${socket.id}가 방 ${roomCode}에 참가`);
    });

    // 게임 시작
    socket.on('startGame', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '방을 찾을 수 없습니다.');
            return;
        }

        if (room.players.length < 2) {
            socket.emit('error', '두 명의 플레이어가 필요합니다.');
            return;
        }

        if (room.gameStarted) {
            socket.emit('error', '이미 게임이 시작되었습니다.');
            return;
        }

        // 게임 시작
        room.gameStarted = true;
        io.to(roomCode).emit('gameStarted');

        console.log(`방 ${roomCode}: 게임 시작`);

        // 30초 타이머 시작
        room.timer = setTimeout(() => {
            endGame(roomCode);
        }, 30000);
    });

    // 카드 뒤집기
    socket.on('flipCell', ({ roomCode, index }) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '방을 찾을 수 없습니다.');
            return;
        }

        if (!room.gameStarted) {
            socket.emit('error', '게임이 아직 시작되지 않았습니다.');
            return;
        }

        // 보드 업데이트
        room.board[index] = 1 - room.board[index];

        // 클릭 수 증가
        room.clicks[socket.id]++;

        // 모든 플레이어에게 업데이트 전송
        io.to(roomCode).emit('boardUpdate', {
            board: room.board,
            clickedIndex: index,
            clickedBy: socket.id,
            clicks: room.clicks
        });

        // 36칸 올킬 체크
        const redCount = room.board.filter(cell => cell === 0).length;
        const blueCount = 36 - redCount;

        if (redCount === 36 || blueCount === 36) {
            // 즉시 게임 종료
            clearTimeout(room.timer);
            endGame(roomCode, true); // 올킬 플래그 전달
        }

        console.log(`방 ${roomCode}: 칸 ${index} 뒤집힘 (빨강:${redCount}, 파랑:${blueCount})`);
    });

    // 게임 종료 함수
    function endGame(roomCode, isAllKill = false) {
        const room = rooms.get(roomCode);
        if (!room || !room.gameStarted) return;

        room.gameStarted = false;

        // 점수 계산
        const redScore = room.board.filter(cell => cell === 0).length;
        const blueScore = 36 - redScore;

        const p1Clicks = room.clicks[room.players[0]] || 0;
        const p2Clicks = room.clicks[room.players[1]] || 0;

        let winner = '';
        let winType = isAllKill ? 'allkill' : 'normal';

        // 승자 결정
        if (redScore > blueScore) {
            winner = 'red';
        } else if (blueScore > redScore) {
            winner = 'blue';
        } else {
            // 동점일 경우 클릭 수가 적은 쪽이 승리
            if (p1Clicks < p2Clicks) {
                winner = 'red';
            } else if (p2Clicks < p1Clicks) {
                winner = 'blue';
            } else {
                winner = 'tie';
            }
        }

        // 게임 결과 전송
        io.to(roomCode).emit('gameOver', {
            winner,
            redScore,
            blueScore,
            p1Clicks,
            p2Clicks,
            winType
        });

        console.log(`방 ${roomCode}: 게임 종료 - 승자: ${winner} (${winType})`);
    }

    // 재대결
    socket.on('rematch', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '방을 찾을 수 없습니다.');
            return;
        }

        // 타이머 초기화
        if (room.timer) {
            clearTimeout(room.timer);
            room.timer = null;
        }

        // 보드 및 게임 상태 초기화 (18:18)
        room.board = createInitialBoard();
        room.clicks = {};
        room.players.forEach(playerId => {
            room.clicks[playerId] = 0;
        });
        room.gameStarted = false;

        // 모든 플레이어에게 재대결 알림
        io.to(roomCode).emit('rematchStarted', {
            board: room.board
        });

        console.log(`방 ${roomCode}: 재대결 시작`);
    });

    // 연결 해제
    socket.on('disconnect', () => {
        console.log('사용자 연결 해제:', socket.id);

        // 해당 플레이어가 있는 방 찾기
        for (const [roomCode, room] of rooms.entries()) {
            if (room.players.includes(socket.id)) {
                // 타이머 정리
                if (room.timer) {
                    clearTimeout(room.timer);
                }

                socket.to(roomCode).emit('opponentLeft');
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
