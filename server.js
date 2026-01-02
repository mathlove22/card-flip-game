const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 정적 파일 제공
app.use(express.static('public'));

// 게임 방 관리
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('사용자 연결:', socket.id);

    // 방 생성
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        // 초기 보드 생성 (랜덤)
        const initialBoard = Array(36).fill(0).map(() => Math.random() > 0.5 ? 0 : 1);

        rooms.set(roomCode, {
            board: initialBoard,
            players: [socket.id],
            clicks: { [socket.id]: 0 }
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

        console.log(`${socket.id}가 방 ${roomCode}에 참가`);
    });

    // 카드 뒤집기
    socket.on('flipCell', ({ roomCode, index }) => {
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', '방을 찾을 수 없습니다.');
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

        console.log(`방 ${roomCode}: 칸 ${index} 뒤집힘`);
    });

    // 연결 해제
    socket.on('disconnect', () => {
        console.log('사용자 연결 해제:', socket.id);

        // 해당 플레이어가 있는 방 찾기
        for (const [roomCode, room] of rooms.entries()) {
            if (room.players.includes(socket.id)) {
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
