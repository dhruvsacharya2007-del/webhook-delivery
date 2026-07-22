const express = require('express');
const { validate } = require('../middleware/validate');
const { createEndpointSchema } = require('../validators/endpoint.validator');
const endpointController = require('../controllers/endpoint.controller');
const { idParamSchema } = require('../validators/delivery.validator');
const deliveryController = require('../controllers/delivery.controller');

const router = express.Router();

router.post('/', validate(createEndpointSchema), endpointController.createEndpoint);



router.post(
  '/:id/redrive',
  validate(idParamSchema),
  deliveryController.redriveEndpointFailures,
);
 
module.exports = router;