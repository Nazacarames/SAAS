import Ticket from "../../models/Ticket";
import Contact from "../../models/Contact";
import User from "../../models/User";

interface ListTicketsRequest {
    companyId: number;
    status?: string;
    contactId?: number;
}

const ListTicketsService = async ({ companyId, status, contactId }: ListTicketsRequest): Promise<Ticket[]> => {
    const whereCondition: any = { companyId };

    if (status) {
        whereCondition.status = status;
    }

    if (contactId) {
        whereCondition.contactId = contactId;
    }

    const tickets = await Ticket.findAll({
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
        order: [["updatedAt", "DESC"]]
    });

    return tickets;
};

export default ListTicketsService;
