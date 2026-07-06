const logoutBtn = document.getElementById('logout-btn');
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ============ 账号管理 ============
const newUsername = document.getElementById('new-username');
const newPassword = document.getElementById('new-password');
const newExpires = document.getElementById('new-expires');
const createAccountBtn = document.getElementById('create-account-btn');
const accountMsg = document.getElementById('account-msg');
const accountsTbody = document.getElementById('accounts-tbody');

async function loadAccounts() {
  const res = await fetch('/api/admin/accounts');
  const list = await res.json();
  accountsTbody.innerHTML = '';
  list.forEach((acc) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = acc.username;
    tr.appendChild(tdName);

    const tdExpire = document.createElement('td');
    const expireInput = document.createElement('input');
    expireInput.type = 'date';
    expireInput.value = acc.expiresAt ? acc.expiresAt.slice(0, 10) : '';
    expireInput.addEventListener('change', () => updateAccount(acc.username, { expiresAt: expireInput.value }));
    tdExpire.appendChild(expireInput);
    tr.appendChild(tdExpire);

    const tdStatus = document.createElement('td');
    const statusBtn = document.createElement('button');
    statusBtn.className = 'btn-secondary';
    statusBtn.textContent = acc.enabled ? '✅ 已启用' : '⛔ 已停用';
    statusBtn.addEventListener('click', () => updateAccount(acc.username, { enabled: !acc.enabled }));
    tdStatus.appendChild(statusBtn);
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-ghost';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deleteAccount(acc.username));
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    accountsTbody.appendChild(tr);
  });
}

async function updateAccount(username, patch) {
  await fetch(`/api/admin/accounts/${encodeURIComponent(username)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  loadAccounts();
}

async function deleteAccount(username) {
  if (!confirm(`确定删除账号 ${username} 吗?`)) return;
  await fetch(`/api/admin/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' });
  loadAccounts();
}

createAccountBtn.addEventListener('click', async () => {
  const username = newUsername.value.trim();
  const password = newPassword.value;
  const expiresAt = newExpires.value || null;
  if (!username || !password) { accountMsg.textContent = '请填写账号和密码'; return; }
  const res = await fetch('/api/admin/accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, expiresAt }),
  });
  const data = await res.json();
  if (!res.ok) { accountMsg.textContent = data.error; return; }
  accountMsg.textContent = '账号创建成功';
  newUsername.value = ''; newPassword.value = ''; newExpires.value = '';
  loadAccounts();
});

// ============ 视频片库管理 ============
const videoTitle = document.getElementById('video-title');
const videoPoster = document.getElementById('video-poster');
const videoFile = document.getElementById('video-file');
const uploadVideoBtn = document.getElementById('upload-video-btn');
const videoUploadStatus = document.getElementById('video-upload-status');
const libraryGrid = document.getElementById('library-grid');

async function loadLibrary() {
  const res = await fetch('/api/library');
  const list = await res.json();
  libraryGrid.innerHTML = '';
  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'library-card';
    card.innerHTML = `
      <div class="poster">${item.posterUrl ? `<img src="${item.posterUrl}" alt="">` : '🎬'}</div>
      <div class="library-card-title">${item.title}</div>
      <button class="btn-ghost del-video-btn">删除</button>
    `;
    card.querySelector('.del-video-btn').addEventListener('click', async () => {
      if (!confirm(`确定删除《${item.title}》吗?`)) return;
      await fetch(`/api/admin/library/${item.id}`, { method: 'DELETE' });
      loadLibrary();
    });
    libraryGrid.appendChild(card);
  });
}

uploadVideoBtn.addEventListener('click', () => {
  const title = videoTitle.value.trim();
  const file = videoFile.files[0];
  if (!title) { videoUploadStatus.textContent = '请填写标题'; return; }
  if (!file) { videoUploadStatus.textContent = '请选择视频文件'; return; }

  const form = new FormData();
  form.append('title', title);
  form.append('video', file);
  if (videoPoster.files[0]) form.append('poster', videoPoster.files[0]);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/admin/library');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) videoUploadStatus.textContent = `上传中... ${Math.round((e.loaded / e.total) * 100)}%`;
  };
  xhr.onload = () => {
    if (xhr.status === 200) {
      videoUploadStatus.textContent = '上传成功';
      videoTitle.value = ''; videoPoster.value = ''; videoFile.value = '';
      loadLibrary();
    } else {
      videoUploadStatus.textContent = '上传失败: ' + (JSON.parse(xhr.responseText || '{}').error || xhr.status);
    }
  };
  xhr.onerror = () => { videoUploadStatus.textContent = '上传失败,请检查网络'; };
  videoUploadStatus.textContent = '开始上传...';
  xhr.send(form);
});

loadAccounts();
loadLibrary();
