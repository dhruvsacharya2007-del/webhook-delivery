const express = require('express');
const { validate } = require('../middleware/validate');
const {
  listDeliveriesSchema,
  idParamSchema,
} = require('../validators/delivery.validator');
const deliveryController = require('../controllers/delivery.controller');

const router = express.Router();


router.get('/', validate(listDeliveriesSchema), deliveryController.listDeliveries);

router.post('/:id/redrive', validate(idParamSchema), deliveryController.redriveDelivery);
 
module.exports = router;