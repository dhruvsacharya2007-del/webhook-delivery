const express = require('express');
const { validate } = require('../middleware/validate');
const { createEventSchema } = require('../validators/event.validator');
const eventController = require('../controllers/event.controller');

const router = express.Router();

// Mounted at /events in app.js. The schema validates the body AND the
// required Idempotency-Key header before the controller runs.
router.post('/', validate(createEventSchema), eventController.createEvent);

module.exports = router;