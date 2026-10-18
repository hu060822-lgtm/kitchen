'use strict';
const q = new URLSearchParams(location.search);
const url = q.get('url') || '';
document.getElementById('url').textContent = url;
document.getElementById('why').textContent = q.get('why') || '';
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:\/\//i.test(url)) location.href = url;
});
document.getElementById('back').addEventListener('click', () => window.lastTableApp && window.lastTableApp.home());
