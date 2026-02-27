import { Op } from "sequelize";
import AppError from "../../errors/AppError";
import sequelize from "../../database";
import Contact from "../../models/Contact";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import User from "../../models/User";
import Whatsapp from "../../models/Whatsapp";
import { removeWbot } from "../../libs/wbot";

interface DeleteWhatsappRequest {
  whatsappId: number;
  companyId: number;
}

const DeleteWhatsappService = async ({ whatsappId, companyId }: DeleteWhatsappRequest): Promise<void> => {
  const whatsapp = await Whatsapp.findOne({ where: { id: whatsappId, companyId } });

  if (!whatsapp) {
    throw new AppError("WhatsApp connection not found", 404);
  }

  await sequelize.transaction(async transaction => {
    await User.update({ whatsappId: null }, { where: { whatsappId, companyId }, transaction });
    await Contact.update({ whatsappId: null }, { where: { whatsappId, companyId }, transaction });

    const tickets = await Ticket.findAll({
      where: { whatsappId, companyId },
      attributes: ["id"],
      transaction
    });

    const ticketIds = tickets.map(t => t.id);

    if (ticketIds.length > 0) {
      await Message.destroy({
        where: { ticketId: { [Op.in]: ticketIds } },
        transaction
      });

      await Ticket.destroy({
        where: { id: { [Op.in]: ticketIds } },
        transaction
      });
    }

    await whatsapp.destroy({ transaction });
  });

  removeWbot(whatsappId);
};

export default DeleteWhatsappService;
