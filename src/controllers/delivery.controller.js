const deliveryService = require('../services/delivery.service');


async function listDeliveries(req, res) {
  
  const { endpointId, failureReason, cursor, limit } = req.validatedQuery;

  const result = await deliveryService.listFailedDeliveries({
    endpointId,
    failureReason,
    cursor,
    limit,
  });

  res.json(result);
}


async function redriveDelivery(req, res) {
  const { id } = req.params;
 
  const { redriven } = await deliveryService.redriveDelivery(id);
 
  if (!redriven) {
    const exists = await deliveryService.deliveryExists(id);
    if (!exists) {
      throw new AppError(404, 'Delivery not found');
    }
    throw new AppError(409, 'Delivery is not in a FAILED state; nothing to redrive');
  }
 
  res.json({ redriven: true, id });
}
 

async function redriveEndpointFailures(req, res) {
  const { id } = req.params;
 
  const result = await deliveryService.redriveEndpointFailures(id);
 
  res.json({
    endpointId: id,
    redrivenCount: result.redrivenCount,
    deliveryIds: result.deliveryIds,
  });
}
 
module.exports = {
  listDeliveries,
  redriveDelivery,
  redriveEndpointFailures,
};
 