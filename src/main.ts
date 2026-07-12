import './styles.css';
import { App } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('App root not found.');

new App(root);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./service-worker.js');
  });
}
