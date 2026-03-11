const svc = require('./dist/services/TokkoServices/TokkoService');
(async () => {
  const r = await svc.syncLeadToTokko({
    name: 'Test Tokko',
    phone: '+5491155519999',
    email: 'tokko-test@charlott.ai',
    message: 'Lead desde CRM META',
    source: 'meta_lead_ads'
  });
  console.log(JSON.stringify(r));
})().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
