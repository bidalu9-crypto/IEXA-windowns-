'use strict';
const code = document.getElementById('code');
const initial = new URLSearchParams(location.hash.slice(1)).get('login');
history.replaceState({}, '', location.pathname);
async function login(event) {
  if (event) event.preventDefault();
  try {
    const response = await fetch('/api/auth/bootstrap', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:code.value.trim()}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '登录失败');
    code.value = ''; location.replace('/');
  } catch (error) { document.getElementById('status').textContent = error.message; }
}
document.getElementById('login').addEventListener('submit', login);
if (initial) { code.value = initial; login(); }
