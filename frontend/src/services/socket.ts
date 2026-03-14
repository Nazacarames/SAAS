import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL?.replace('/api', '') || '';

class SocketConnection {
    private socket: Socket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    connect() {
        if (this.socket?.connected) {
            return this.socket;
        }

        // Clean up any existing disconnected socket before creating a new one
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }

        this.socket = io(SOCKET_URL || window.location.origin, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
        });

        this.socket.on('connect', () => {
            console.log('Socket conectado:', this.socket?.id);
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('Socket desconectado:', reason);
            // If the server closed the connection, auto-reconnect after a brief delay
            if (reason === 'io server disconnect') {
                this.reconnectTimer = setTimeout(() => {
                    console.log('Reintentando conexión socket...');
                    this.socket?.connect();
                }, 2000);
            }
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
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
    }

    getSocket(): Socket | null {
        return this.socket;
    }

    isConnected(): boolean {
        return this.socket?.connected ?? false;
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
