jest.mock("../../models/Contact", () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock("../../models/Ticket", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../models/Message", () => ({ __esModule: true, default: { findOne: jest.fn(), count: jest.fn(), create: jest.fn() } }));
jest.mock("../../models/Whatsapp", () => ({ __esModule: true, default: { findByPk: jest.fn(), findOne: jest.fn() } }));
jest.mock("../../models/Webhook", () => ({ __esModule: true, default: { findByPk: jest.fn() } }));
jest.mock("../../services/SettingsServices/RuntimeSettingsService", () => ({
  getRuntimeSettings: () => ({
    waRecapEnabled: true,
    waRecapTemplateName: "recap_3d",
    waRecapTemplateLang: "es_AR",
    waRecapInactivityMinutes: 4320,
    waCloudPhoneNumberId: "123",
    waCloudAccessToken: "token"
  })
}));
jest.mock("../../database", () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock("../../libs/socket", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import sequelize from "../../database";
import Whatsapp from "../../models/Whatsapp";
import CheckInactiveContactsService from "../../services/ContactServices/CheckInactiveContactsService";

describe("critical/recaptación 3 días", () => {
  it("envía template cuando el lead está inactivo >= 4320 min y último mensaje fue fromMe", async () => {
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const contactUpdate = jest.fn().mockResolvedValue(undefined);
    (Contact.findAll as jest.Mock).mockResolvedValue([
      { id: 1, companyId: 1, number: "5493411234567", leadStatus: "new", inactivityMinutes: 0, lastInteractionAt: oldDate, update: contactUpdate }
    ]);

    (Whatsapp.findByPk as jest.Mock).mockResolvedValue({ id: 10 });
    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 10 });
    (Ticket.findOne as jest.Mock).mockResolvedValue({ id: 11, update: jest.fn() });
    (Message.findOne as jest.Mock).mockResolvedValue({ fromMe: true });
    (Message.count as jest.Mock).mockResolvedValue(1);
    (Message.create as jest.Mock).mockResolvedValue({ id: "wamid.recap" });

    (sequelize.query as jest.Mock).mockResolvedValue([{ phone_number_id: "123", access_token: "token" }]);
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.recap" }] }) });

    await CheckInactiveContactsService();

    expect((global as any).fetch).toHaveBeenCalled();
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("recap_3d") }));
    expect(contactUpdate).toHaveBeenCalledWith(expect.objectContaining({ lastInactivityFiredAt: expect.any(Date) }));
  });
});
