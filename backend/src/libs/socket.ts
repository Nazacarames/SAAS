import { Server as SocketIO } from "socket.io";
import { Server } from "http";
import { verifyToken } from "../helpers/jwt";
import Ticket from "../models/Ticket";

let io: SocketIO;

export const initIO = (httpServer: Server): SocketIO => {
    io = new SocketIO(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || "http://localhost:3000",
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    // Authentication middleware
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
        if (!token) {
            return next(new Error("Authentication required"));
        }
        try {
            const decoded = verifyToken(token);
            (socket as any).user = decoded;
            next();
        } catch {
            next(new Error("Invalid token"));
        }
    });

    io.on("connection", (socket) => {
        const user = (socket as any).user;
        console.log(`Cliente conectado: ${socket.id} (user ${user?.id}, company ${user?.companyId})`);

        // Join company-scoped room automatically
        if (user?.companyId) {
            socket.join(`company-${user.companyId}`);
        }

        socket.on("joinChatBox", async (ticketId: string) => {
            // Verify ticket belongs to user's company before joining
            const ticket = await Ticket.findOne({
                where: { id: Number(ticketId), companyId: user?.companyId },
                attributes: ["id"]
            });
            if (!ticket) {
                socket.emit("error", { message: "Ticket no encontrado" });
                return;
            }
            const room = `company-${user?.companyId}:ticket-${ticketId}`;
            socket.join(room);
        });

        socket.on("joinNotification", () => {
            const room = `company-${user?.companyId}:notification`;
            socket.join(room);
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
