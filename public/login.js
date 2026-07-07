const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const nameInput = document.getElementById('join-name');
const roomInput = document.getElementById('join-room');
const loginBtn = document.getElementById('login-btn');
const hint = document.getElementById('login-hint');

// 支持通过邀请链接带上房间号自动填入,例如 /login.html#room=ABC123
const hashMatch = location.hash.match(/room=([A-Za-z0-9]+)/);
if (hashMatch) roomInput.value = hashMatch[1];

async function doLogin() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  if (!username || !password) { hint.textContent = '请输入账号和密码'; return; }
  if (!name) { hint.textContent = '请输入你的名称'; return; }

  hint.textContent = '';
  loginBtn.style.pointerEvents = 'none';
  loginBtn.textContent = '进入中...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      hint.textContent = data.error || '登录失败';
      loginBtn.style.pointerEvents = 'auto';
      loginBtn.textContent = '进入影厅';
      return;
    }

    // 管理员登录直接进后台,不带房间信息
    if (data.redirect === '/admin.html') {
      location.href = data.redirect;
      return;
    }

    // 普通用户:把名字和房间号记下来,带到放映厅页面自动入座
    sessionStorage.setItem('wt_name', name);
    sessionStorage.setItem('wt_room', roomInput.value.trim());
    location.href = data.redirect || '/';
  } catch (e) {
    hint.textContent = '网络错误,请重试';
    loginBtn.style.pointerEvents = 'auto';
    loginBtn.textContent = '进入影厅';
  }
}

loginBtn.addEventListener('click', doLogin);
[usernameInput, passwordInput, nameInput, roomInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
});
