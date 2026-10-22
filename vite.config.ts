import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * 两套开发配置：
 *   npm run dev        —— http://localhost:5173（电脑自测，localhost 属于安全上下文，可调摄像头）
 *   npm run dev:https  —— https://<电脑IP>:5173（手机同 WiFi 真机测试，浏览器要求安全上下文）
 *
 * 注意：public/mp 下的 MediaPipe 运行时与模型必须在运行时按绝对路径 /mp/* 提供，
 * 因此 index.html 里用 <script src="/mp/pose.js"> 直接引入，不参与打包。
 */
export default defineConfig(({ mode }) => {
  const useHttps = mode === 'https';
  return {
    base: './',
    plugins: useHttps ? [basicSsl()] : [],
    server: {
      host: true,
      port: 5173,
      // 手机端需要访问局域网 IP，host: true 已覆盖
    },
    preview: {
      host: true,
      port: 4173,
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
