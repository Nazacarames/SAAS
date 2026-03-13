import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import User from "../../models/User";

interface ListTicketsRequest {
    companyId: number;
    status?: string;
    contactId?: number;
    page?: number;
    limit?: number;
}

const ListTicketsService = async ({ companyId, status, contactId, page = 1, limit = 50 }: ListTicketsRequest) => {
    const whereCondition: any = { companyId };

    if (status) {
        whereCondition.status = status;
    }

    if (contactId) {
        whereCondition.contactId = contactId;
    }

    const safeLimit = Math.min(Math.max(1, limit), 200);
    const offset = (Math.max(1, page) - 1) * safeLimit;

    const { rows, count } = await Ticket.findAndCountAll({
        where: whereCondition,
        include: [
            {
                model: Contact,
                as: "contact",
                attributes: ["id", "name", "number", "profilePicUrl"]
            },
            {
                model: User,
                as: "user",
                attributes: ["id", "name"]
            }
        ],
        order: [["updatedAt", "DESC"]],
        limit: safeLimit,
        offset,
        distinct: true
    });

    return { data: rows, total: count, page, limit: safeLimit, totalPages: Math.ceil(count / safeLimit) };
};

export default ListTicketsService;
