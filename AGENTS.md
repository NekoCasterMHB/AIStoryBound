# AI StoryBound(AI Word2World)项目记忆

## 测试账户(本地/远程开发测试统一使用)

| 项 | 值 |
| --- | --- |
| 邮箱 | `testuser@example.com` |
| 用户名 | 测试玩家 |
| 密码 | `testpass123` |
| 用户 id(云端 D1) | `dEIoUv2Eq8yqTRaKDFTQq9KU3ymqUt0j` |
| 注册方式 | 邮箱 + 验证码 |

### 使用说明

- 登录方式:邮箱 + 密码直接登录(无需验证码);若流程需要验证码(如重注册),验证码存云端 D1 `verification` 表,`identifier` 含 `testuser`,用 `npx wrangler d1 execute aiword2world --remote --command "SELECT identifier, value FROM verification WHERE identifier LIKE '%testuser%'"` 查询(注意列名是 `expires_at` / `created_at` 下划线命名)。
- 该账户为正式保留的测试账号,不要删除;页面测试(登录、书架、游戏流程)默认使用它。
