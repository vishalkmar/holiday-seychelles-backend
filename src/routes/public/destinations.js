const router = require('express').Router();
const destinations = require('../../services/destinations');
const { sendSuccess, sendError } = require('../../utils/response');
router.get('/', async (_req, res) => {
  try {
    const [records, config] = await Promise.all([destinations.list(), destinations.getConfig()]);
    const items = config.enabled ? records.map(({ id, slug, name, tagline, heroImage }) => ({ id, slug, name, tagline, heroImage })) : [];
    res.set('Cache-Control', 'no-cache');
    sendSuccess(res, { items, config });
  } catch (error) { sendError(res, error, 'Unable to load destinations.', 503); }
});
router.get('/:slug', async (req, res) => {
  try {
    const [destination, config] = await Promise.all([destinations.get(req.params.slug), destinations.getConfig()]);
    res.set('Cache-Control', 'no-cache');
    sendSuccess(res, { destination, backgroundImage: config.backgroundImage });
  } catch (error) { sendError(res, error, error.status ? error.message : 'Unable to load destination.', error.status || 503); }
});
module.exports = router;
