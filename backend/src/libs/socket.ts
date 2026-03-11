import { Server as SocketIO } from "socket.io";
import { Server } from "http";

let io: SocketIO;

export const initIO = (httpServer: Server): SocketIO => {
    io = new SocketIO(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || "http://localhost:3000",
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    io.on("connection", (socket) => {
        console.log("Cliente conectado:", socket.id);

        socket.on("joinChatBox", (ticketId: string) => {
            socket.join(ticketId);
            console.log(`Socket ${socket.id} se unió a ticket ${ticketId}`);
        });

        socket.on("joinNotification", () => {
            socket.join("notification");
            console.log(`Socket ${socket.id} se unió a notificaciones`);
        });

        socket.on("disconnect", () => {
            console.log("Cliente desconectado:", socket.id);
        });
    });

    return io;
};

export const getIO = (): SocketIO => {
    if (!io) {
        throw new Error("Socket.io no está inicializado");
    }
    return io;
};
