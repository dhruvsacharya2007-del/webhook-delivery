module.exports = {
  testEnvironment: 'node',
  
  ...(process.env.USE_PRISMA_SHIM
    ? { moduleNameMapper: { '^.*/generated/prisma$': '<rootDir>/tests/prisma-shim.js' } }
    : {}),
  
  setupFiles: ['<rootDir>/tests/setup-env.js'],

  setupFilesAfterEnv: ['<rootDir>/tests/setup-db.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  
  maxWorkers: 1,
  testTimeout: 15000,
};