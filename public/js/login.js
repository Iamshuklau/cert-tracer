const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const changePasswordModal = document.getElementById('change-password-modal');
const changePasswordForm = document.getElementById('change-password-form');
const changePasswordError = document.getElementById('change-password-error');

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function hideError(el) {
  el.hidden = true;
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, data: { error: 'Could not reach the server' } };
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, data: { error: data.error || `Request failed (${res.status})`, ...data } };
}

async function withDisabled(form, fn) {
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  hideError(loginError);
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  withDisabled(loginForm, async () => {
    const { ok, data } = await postJson('/api/auth/login', { username, password });
    if (!ok) {
      showError(loginError, data.error);
      return;
    }
    if (data.mustChangePassword) {
      changePasswordModal.hidden = false;
      document.getElementById('new-password').focus();
    } else {
      window.location.href = '/index.html';
    }
  });
});

changePasswordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  hideError(changePasswordError);
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  if (newPassword !== confirmPassword) {
    showError(changePasswordError, 'Passwords do not match');
    return;
  }

  withDisabled(changePasswordForm, async () => {
    const { ok, data } = await postJson('/api/auth/change-password', { newPassword });
    if (!ok) {
      showError(changePasswordError, data.error);
      return;
    }
    window.location.href = '/index.html';
  });
});
