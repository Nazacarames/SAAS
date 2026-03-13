jest.mock("../../models/Contact", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn() }
}));

jest.mock("../../models/Whatsapp", () => ({
  __esModule: true,
  default: { findOne: jest.fn() }
}));

jest.mock("../../services/TokkoServices/TokkoService", () => ({
  syncLeadToTokko: jest.fn()
}));

jest.mock("../../models/Tag", () => ({
  __esModule: true,
  default: { findOrCreate: jest.fn() }
}));

jest.mock("../../models/ContactTag", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn() }
}));

import CreateLeadService from "../../services/IntegrationServices/CreateLeadService";
import Contact from "../../models/Contact";
import Whatsapp from "../../models/Whatsapp";
import Tag from "../../models/Tag";
import ContactTag from "../../models/ContactTag";
import { syncLeadToTokko } from "../../services/TokkoServices/TokkoService";

describe("critical/lead -> tokko", () => {
  it("sincroniza a Tokko solo para lead nuevo y marca tag enviado_tokko", async () => {
    (Whatsapp.findOne as jest.Mock).mockResolvedValue({ id: 9 });
    (Contact.findOne as jest.Mock).mockResolvedValue(null);
    (Contact.create as jest.Mock).mockResolvedValue({ id: 33, number: "5493411234567" });
    (syncLeadToTokko as jest.Mock).mockResolvedValue({ ok: true, status: 201 });
    (Tag.findOrCreate as jest.Mock).mockResolvedValue([{ id: 88 }]);
    (ContactTag.findOne as jest.Mock).mockResolvedValue(null);

    const res = await CreateLeadService({
      companyId: 1,
      name: "Lead Nuevo",
      number: "+54 9 341 123-4567",
      source: "integration_api"
    });

    expect(syncLeadToTokko).toHaveBeenCalledTimes(1);
    expect(ContactTag.create).toHaveBeenCalledWith({ contactId: 33, tagId: 88 });
    expect(res.tokko.ok).toBe(true);
  });
});
