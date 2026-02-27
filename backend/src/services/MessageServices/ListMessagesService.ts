import Message from "../../models/Message";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";

interface ListMessagesRequest {
    contactId?: number;
    ticketId?: number;
}

const ListMessagesService = async ({ contactId, ticketId }: ListMessagesRequest): Promise<Message[]> => {
    const where: any = contactId ? { contactId } : { ticketId };
    const messages = await Message.findAll({
        where,
        include: [
            {
                model: Contact,
                as: "contact",
                attributes: ["id", "name", "number", "profilePicUrl"]
            }
        ],
        order: [["createdAt", "ASC"]]
    });

    return messages;
};

export default ListMessagesService;
