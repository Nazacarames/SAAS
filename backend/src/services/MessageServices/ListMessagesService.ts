import Message from "../../models/Message";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";

interface ListMessagesRequest {
    contactId?: number;
    ticketId?: number;
    companyId: number;
    page?: number;
    limit?: number;
}

const ListMessagesService = async ({ contactId, ticketId, companyId, page = 1, limit = 50 }: ListMessagesRequest) => {
    const baseWhere: any = contactId ? { contactId } : { ticketId };

    const safeLimit = Math.min(Math.max(1, limit), 200);
    const offset = (Math.max(1, page) - 1) * safeLimit;

    const { rows, count } = await Message.findAndCountAll({
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
        order: [["createdAt", "ASC"]],
        limit: safeLimit,
        offset,
        distinct: true
    });

    return { data: rows, total: count, page, limit: safeLimit, totalPages: Math.ceil(count / safeLimit) };
};

export default ListMessagesService;
