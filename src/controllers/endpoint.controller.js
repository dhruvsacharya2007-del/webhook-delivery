const endpointService = require('../services/endpoint.service');

async function createEndpoint(req, res) {
  const endpoint = await endpointService.createEndpoint(req.body);

  res.status(201).json(endpoint);
}

module.exports = {
  createEndpoint,
};