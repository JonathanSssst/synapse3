import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import './styles/base.css';

const app = createApp(App);
app.use(router);
app.mount('#app');

// 全局兜底：组件异常不白屏
app.config.errorHandler = (err, instance, info) => {
  console.error('[panel-ui]', err, info);
};
