/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          lib: ['ES2022', 'DOM'],
          esModuleInterop: true,
        },
      },
    ],
  },
};
