# 放映厅 · 私密同步观影(账号制 + 房主模式 + 视频片库)

## 这一版有什么

- **账号登录**:所有人必须先登录才能进放映厅,账号由你(管理员)创建和管理
- **管理后台**:你专属的后台页面,可以新建账号、设置到期日、随时启用/停用某个账号(适合按月收费管理)
- **视频片库**:后台上传视频+封面图,做成像 Netflix 一样的海报墙,房主进房间后点"从片库选择"就能直接播放,不用每次重新传文件或粘贴链接
- **房主模式**:创建房间的人是房主,只有房主能选视频源、控制播放/暂停/进度,其他人跟着看
- 麦克风开关、文字聊天,这些之前就有的功能保留不变

## 一、环境变量配置(必须先做)

复制 `.env.example` 为 `.env`,把里面的值改成你自己的:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=一个只有你知道的密码
SESSION_SECRET=一串随机字符串,比如用密码生成器生成一串
R2_ACCOUNT_ID=(参考"接入Cloudflare R2"部分获取)
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=
```

**`ADMIN_PASSWORD` 和 `SESSION_SECRET` 必须填,不填的话管理后台登不进去、登录状态也保存不住。** R2 那五项如果暂时不填,程序会自动退回"本地磁盘存储"模式,能跑但服务器一重启数据就没了,只适合本地测试,正式给别人用之前一定要配上 R2。

## 二、本地运行测试

```bash
cd watch-together
npm install
npm start
```

浏览器打开 `http://localhost:3000`,会先跳到登录页,用你在 `.env` 里设置的 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 登录,会直接进管理后台(`/admin.html`),在这里可以:
1. 新建给朋友用的账号(账号名、密码、到期日,到期日留空 = 不过期)
2. 上传视频到片库(标题 + 封面图 + 视频文件)

朋友用他们自己的账号登录后,进的是放映厅主界面(不是后台),创建房间当房主,点"从片库选择"就能选你传好的视频一起看。

## 三、部署到网上给别人用

跟之前一样,部署到 Render / Railway / Fly.io 这类支持 Node.js 的平台,记得在平台的 **Environment / 环境变量** 设置里,把 `.env` 里那几项一条条加上去(不要把 `.env` 文件本身传上 GitHub,`.gitignore` 已经帮你排除了)。

## 四、账号管理怎么用来收费

这套系统**不包含自动收款功能**(不接支付宝/微信支付/信用卡这些),账号到期和收费是靠你自己线下管理的:

1. 朋友找你付了钱,你在后台给 ta 建一个账号,到期日填一个月后的日期
2. 到期前提醒续费,续费了就去后台把到期日往后改;不续费就不用管,账号到期自动登录不了
3. 如果有人违规或者你想临时停用某人,直接点"停用"按钮,不用等到期,立刻生效

## 五、接入 Cloudflare R2(视频/账号数据永久存储)

1. 注册 **https://dash.cloudflare.com/sign-up**(免费,但激活 R2 需要绑定一张信用卡/借记卡,超出免费额度才会扣费,10GB 存储 + 免流量费基本用不到收费)
2. 左侧菜单找到 **R2 Object Storage**,点开通
3. 点 **Create bucket**,起个名字比如 `watch-together-videos`,创建
4. 进入这个 bucket,找 **Settings** → **Public Development URL**,点启用,会给你一个类似 `https://pub-xxxxxxxx.r2.dev` 的地址,这个填到 `.env` 的 `R2_PUBLIC_URL`
5. 回到 R2 总览页,找 **Manage R2 API Tokens** → **Create API Token**,权限选 **Object Read & Write**,作用范围选刚才那个 bucket,创建后会显示 **Access Key ID** 和 **Secret Access Key**(只显示一次,马上复制保存),分别填到 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`
6. **Account ID** 在 Cloudflare 控制台右侧栏能看到(一串字母数字),填到 `R2_ACCOUNT_ID`
7. `R2_BUCKET_NAME` 填第 3 步起的 bucket 名字

全部填完,本地重启一次 `npm start`,如果日志显示"云存储已启用(Cloudflare R2)"就说明配置成功了。部署到 Render 时,记得把这几个变量也同步加到 Render 的 Environment 设置里。

## 关于内容合规,再强调一次

片库里放的视频,必须是你自己拥有版权、或者有权公开分发的内容(自己拍的、正规授权的素材等)。这套工具只负责"存储+播放+账号权限管理",不会也不应该被用来分发你没有权利传播的影视/短视频内容。

## 文件说明

- `server.js`:登录鉴权、账号管理API、视频片库API、房间同步、语音信令,全部逻辑都在这
- `public/login.html` `login.js`:公开的登录页
- `views/index.html`:放映厅主界面(需要登录才能访问)
- `views/admin.html` + `public/admin.js`:管理后台(需要管理员登录)
- `public/client.js` `style.css`:放映厅的前端逻辑和样式
