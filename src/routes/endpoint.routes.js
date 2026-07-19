const express = require('express');
const { validate } = require('../middleware/validate');
const { createEndpointSchema } = require('../validators/endpoint.validator');
const endpointController = require('../controllers/endpoint.controller');

const router = express.Router();

router.post('/', validate(createEndpointSchema), endpointController.createEndpoint);

module.exports = router;