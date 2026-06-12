/**
 * esbuild 构建脚本
 * 将 TypeScript 源码打包为 VSCode 插件可用的 CommonJS 格式
 */

const esbuild = require('esbuild');

// 是否为生产构建
const isProduction = process.argv.includes('--production');
// 是否为监听模式
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  // 入口文件
  entryPoints: ['src/extension.ts'],
  // 输出文件
  outfile: 'dist/extension.js',
  // 打包为单文件
  bundle: true,
  // VSCode 插件运行在 Node.js 环境
  platform: 'node',
  // 模块格式：CommonJS（VSCode 要求）
  format: 'cjs',
  // 外部依赖：vscode 由宿主提供，不打包
  external: ['vscode'],
  // 生产模式压缩，开发模式保留源码映射
  minify: isProduction,
  sourcemap: !isProduction,
  // 目标 Node.js 版本（VSCode 1.80 使用 Node 16）
  target: 'node16',
  // 日志级别
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    // 监听模式：文件变化时自动重新构建
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('👀 监听文件变化中...');
  } else {
    // 单次构建
    await esbuild.build(buildOptions);
    console.log(isProduction ? '✅ 生产构建完成' : '✅ 开发构建完成');
  }
}

main().catch((err) => {
  console.error('❌ 构建失败:', err);
  process.exit(1);
});
