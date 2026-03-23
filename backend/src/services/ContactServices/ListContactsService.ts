import Contact from "../../models/Contact";

const ListContactsService = async ({
  companyId,
  status,
  assignedUserId,
  page = 1,
  limit = 50
}: {
  companyId: number;
  status?: string;
  assignedUserId?: number | null;
  page?: number;
  limit?: number;
}) => {
  const where: any = { companyId };
  if (status) where.leadStatus = status;
  if (typeof assignedUserId === "number") where.assignedUserId = assignedUserId;
  if (assignedUserId === null) where.assignedUserId = null;

  const safeLimit = Math.min(Math.max(1, limit), 200);
  const offset = (Math.max(1, page) - 1) * safeLimit;

  const { rows, count } = await Contact.findAndCountAll({
    where,
    include: [
      { association: "tags", through: { attributes: [] }, required: false },
      { association: "assignedUser", required: false },
      // Limit tickets to 1 most recent per contact to avoid N+1 explosion
      {
        association: "tickets",
        required: false,
        attributes: ["id", "status", "unreadMessages", "updatedAt"],
        limit: 1,
        order: [["updatedAt", "DESC"]],
        separate: true
      }
    ],
    order: [["updatedAt", "DESC"]],
    limit: safeLimit,
    offset,
    distinct: true
  });

  return { data: rows, total: count, page, limit: safeLimit, totalPages: Math.ceil(count / safeLimit) };
};

export default ListContactsService;
