import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL?.replace('/api', '') || 'http://localhost:4000';

class SocketConnection {
    private socket: Socket | null = null;

    connect(token?: string) {
        if (this.socket?.connected) {
            return this.socket;
        }

        this.socket = io(SOCKET_URL, {
            transports: ['websocket', 'polling'],
            auth: token ? { token } : undefined
        });

        this.socket.on('connect', () => {
            console.log('✅ Socket conectado:', this.socket?.id);
        });

        this.socket.on('disconnect', () => {
            console.log('❌ Socket desconectado');
        });

        this.socket.on('connect_error', (error) => {
            console.error('Error de conexión Socket.io:', error);
        });

        return this.socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }

    getSocket(): Socket {
        if (!this.socket) {
            return this.connect();
        }
        return this.socket;
    }

    on(event: string, callback: (...args: any[]) => void) {
        this.getSocket().on(event, callback);
    }

    off(event?: string) {
        if (event) {
            this.getSocket().off(event);
        } else {
            this.getSocket().removeAllListeners();
        }
    }

    emit(event: string, ...args: any[]) {
        this.getSocket().emit(event, ...args);
    }
}

export const socketConnection = new SocketConnection().getSocket();
export default SocketConnection;
