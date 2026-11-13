import { initFirebase } from './firebase.js';

const root = document.getElementById('app');
try {
  const fb = await initFirebase();
  const S = await import('./store.js');
  const { mount } = await import('./ui.js');
  await S.start(fb);
  mount(root);
} catch (e) {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'msg bad';
  p.setAttribute('role', 'alert');
  p.textContent = e.message;
  root.append(p);
}
