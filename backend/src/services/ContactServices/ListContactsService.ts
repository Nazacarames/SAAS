import Contact from "../../models/Contact";

const ListContactsService = async ({
  companyId,
  status,
  assignedUserId
}: {
  companyId: number;
  status?: string;
  assignedUserId?: number | null;
}) => {
  const where: any = { companyId };
  if (status) where.leadStatus = status;
  if (typeof assignedUserId === "number") where.assignedUserId = assignedUserId;
  if (assignedUserId === null) where.assignedUserId = null;

  const contacts = await Contact.findAll({
    where,
    include: [
      { association: "tags", through: { attributes: [] }, required: false },
      { association: "assignedUser", required: false },
      { association: "tickets", required: false, attributes: ["id", "status", "unreadMessages", "updatedAt"] }
    ],
    order: [["updatedAt", "DESC"]]
  });

  return contacts;
};

export default ListContactsService;
