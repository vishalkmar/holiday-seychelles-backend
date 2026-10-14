const router = require('express').Router();
const destinations = require('../../services/destinations');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const handle = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) { sendError(res, error, error.status ? error.message : 'Unable to save or load island configuration.', error.status || 500); }
};
const audit = (req, action, summary) => sec.audit({ req, adminId: req.admin.id, action, entityType: 'website_destination', summary });
router.get('/', handle(async (_req, res) => {
  const [items, config] = await Promise.all([destinations.list(true), destinations.getConfig()]);
  sendSuccess(res, { items, config });
}));
router.put('/configuration', handle(async (req, res) => {
  const config = await destinations.saveConfig(req.body, req.admin.id);
  await audit(req, 'admin.website.islands_configured', 'Updated the island discovery section');
  sendSuccess(res, { config });
}));
router.post('/', handle(async (req, res) => {
  const destination = await destinations.save(req.body);
  await audit(req, 'admin.website.destination_created', `Created ${destination.name}`);
  sendSuccess(res, { destination }, 'Destination created', 201);
}));
router.put('/:id', handle(async (req, res) => {
  const destination = await destinations.save(req.body, req.params.id);
  await audit(req, 'admin.website.destination_updated', `Updated ${destination.name}`);
  sendSuccess(res, { destination });
}));
router.delete('/:id', handle(async (req, res) => {
  await destinations.remove(req.params.id);
  await audit(req, 'admin.website.destination_deleted', `Removed destination ${req.params.id}`);
  sendSuccess(res);
}));
module.exports = router;
