import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL?.replace('/api', '') || '';

class SocketConnection {
    private socket: Socket | null = null;

    connect() {
        if (this.socket?.connected) {
            return this.socket;
        }

        this.socket = io(SOCKET_URL || window.location.origin, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
        });

        this.socket.on('connect', () => {
            console.log('Socket conectado:', this.socket?.id);
        });

        this.socket.on('disconnect', () => {
            console.log('Socket desconectado');
        });

        this.socket.on('connect_error', (error) => {
            console.error('Error de conexion Socket.io:', error.message);
            if (error.message === 'Authentication required' || error.message === 'Invalid token') {
                this.socket?.disconnect();
            }
        });

        return this.socket;
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }

    getSocket(): Socket | null {
        return this.socket;
    }

    on(event: string, callback: (...args: any[]) => void) {
        const socket = this.getSocket();
        if (socket) socket.on(event, callback);
    }

    off(event?: string) {
        const socket = this.getSocket();
        if (!socket) return;
        if (event) {
            socket.off(event);
        } else {
            socket.removeAllListeners();
        }
    }

    emit(event: string, ...args: any[]) {
        const socket = this.getSocket();
        if (socket) socket.emit(event, ...args);
    }
}

const socketConnection = new SocketConnection();
export { socketConnection };
export default SocketConnection;
