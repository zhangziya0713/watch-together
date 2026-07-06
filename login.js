const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const loginBtn = document.getElementById('login-btn');
const hint = document.getElementById('login-hint');

async function doLogin() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) { hint.textContent = '请输入账号和密码'; return; }
  hint.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = '登录中...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      hint.textContent = data.error || '登录失败';
      loginBtn.disabled = false;
      loginBtn.textContent = '登录';
      return;
    }
    location.href = data.redirect || '/';
  } catch (e) {
    hint.textContent = '网络错误,请重试';
    loginBtn.disabled = false;
    loginBtn.textContent = '登录';
  }
}

loginBtn.addEventListener('click', doLogin);
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
