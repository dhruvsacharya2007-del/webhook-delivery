const crypto = require('node:crypto');
const endpointRepository = require('../repositories/endpoint.repository');


function generateSigningSecret() {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Register a new endpoint.
 *
 * Returns the FULL created row, signingSecret included — creation is the one
 * moment the caller is entitled to see it. Read paths will strip it.
 *
 * @param {{ url: string, eventTypes: string[] }} input - already validated
 * @returns {Promise<object>} the created endpoint
 */
async function createEndpoint({ url, eventTypes }) {
  const signingSecret = generateSigningSecret();

  return endpointRepository.create({
    url,
    eventTypes,
    signingSecret,
  });
}

module.exports = {
  createEndpoint,
  generateSigningSecret,
};