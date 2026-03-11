import sequelize from "../../database";
import { QueryTypes } from "sequelize";
import Contact from "../../models/Contact";

interface Request {
  companyId: number;
  contactId: number;
}

const DeleteContactService = async ({ companyId, contactId }: Request) => {
  const contact = await Contact.findOne({ where: { id: contactId, companyId } });
  if (!contact) {
    const err: any = new Error("Contact not found");
    err.statusCode = 404;
    throw err;
  }

  await sequelize.transaction(async (tx: any) => {
    // Evita error FK en messages_contactId_fkey (sin ON DELETE CASCADE)
    await sequelize.query(
      `DELETE FROM messages WHERE "contactId" = :contactId`,
      { replacements: { contactId }, type: QueryTypes.DELETE, transaction: tx }
    );

    await contact.destroy({ transaction: tx } as any);
  });
};

export default DeleteContactService;
