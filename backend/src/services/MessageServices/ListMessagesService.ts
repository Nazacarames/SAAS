import Message from "../../models/Message";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";

interface ListMessagesRequest {
    contactId?: number;
    ticketId?: number;
    companyId: number;
}

const ListMessagesService = async ({ contactId, ticketId, companyId }: ListMessagesRequest): Promise<Message[]> => {
    const baseWhere: any = contactId ? { contactId } : { ticketId };

    const messages = await Message.findAll({
        where: baseWhere,
        include: [
            {
                model: Contact,
                as: "contact",
                attributes: ["id", "name", "number", "profilePicUrl"],
                where: { companyId },
                required: true
            }
        ],
        order: [["createdAt", "ASC"]]
    });

    return messages;
};

export default ListMessagesService;
