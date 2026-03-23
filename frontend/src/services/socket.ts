import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL?.replace('/api', '') || '';

class SocketConnection {
    private socket: Socket | null = null;
    private listeners = new Map<string, Set<(...args: any[]) => void>>();

    connect() {
        // If we have a socket that's already connected, reuse it
        if (this.socket?.connected) {
            return this.socket;
        }

        // Disconnect old socket if exists (even if disconnected, clean it up)
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
            this.listeners.clear();
        }

        this.socket = io(SOCKET_URL || window.location.origin, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
        });

        this.socket.on('connect', () => {
            console.log('Socket conectado:', this.socket?.id);
            // Re-register all listeners on reconnect
            this.reregisterListeners();
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

    private reregisterListeners() {
        // Re-attach all registered listeners to the new socket instance
        for (const [event, callbacks] of this.listeners.entries()) {
            for (const callback of callbacks) {
                this.socket?.on(event, callback);
            }
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
            this.listeners.clear();
        }
    }

    getSocket(): Socket | null {
        return this.socket;
    }

    on(event: string, callback: (...args: any[]) => void) {
        // Store the listener so we can re-attach on reconnect
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(callback);

        // Also attach to current socket if connected
        const socket = this.getSocket();
        if (socket) socket.on(event, callback);
    }

    off(event: string, callback?: (...args: any[]) => void) {
        // Remove from stored listeners
        if (callback) {
            this.listeners.get(event)?.delete(callback);
        } else {
            this.listeners.delete(event);
        }

        // Remove from socket
        const socket = this.getSocket();
        if (!socket) return;
        if (event) {
            if (callback) {
                socket.off(event, callback);
            } else {
                socket.off(event);
            }
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
