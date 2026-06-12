/**
 * Jest 测试配置
 * 用于运行单元测试和属性测试（不依赖 VSCode 环境）
 */

/** @type {import('jest').Config} */
module.exports = {
  // 使用 ts-jest 转换 TypeScript
  preset: 'ts-jest',
  // 测试环境：Node.js（不需要浏览器）
  testEnvironment: 'node',
  // 测试文件匹配规则
  testMatch: [
    '**/src/test/**/*.test.ts',
    '**/src/test/**/*.spec.ts',
  ],
  // 模块路径别名
  moduleNameMapper: {
    // 将 vscode 模块替换为 mock（单元测试不依赖真实 VSCode）
    '^vscode$': '<rootDir>/src/test/__mocks__/vscode.ts',
  },
  // TypeScript 转换配置
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // 测试时放宽部分严格检查
        strict: true,
      },
    }],
  },
  // 覆盖率收集
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/test/**',
    '!src/extension.ts',
  ],
  // 超时时间（属性测试可能需要更长时间）
  testTimeout: 30000,
};
