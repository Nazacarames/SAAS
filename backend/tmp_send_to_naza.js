require('dotenv').config();
const sequelize = require('./dist/database').default;
const SendMessageService = require('./dist/services/MessageServices/SendMessageService').default;

(async()=>{
  try {
    const msg = await SendMessageService({ body: 'test entrega real desde backend ' + new Date().toISOString(), ticketId: 1, userId: 1 });
    console.log('sent', { id: msg.id, ack: msg.ack, ticketId: msg.ticketId, contactId: msg.contactId });
  } catch (e) {
    console.error('send_error', e?.message || e);
    if (e?.response?.data) console.error('resp', e.response.data);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(()=>{});
  }
})();