import { bootstrapNovelApp } from './novel/app.js';

bootstrapNovelApp().catch((error) => {
  const el = document.getElementById('global-status');
  if (el) {
    el.textContent = error?.message || '应用启动失败';
    el.classList.add('error');
  }
});
