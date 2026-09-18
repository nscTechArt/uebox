# HTTP 请求工具

基于 Axios 的请求工具，用于用户明确配置的外部服务。默认基础地址为空，调用方必须提供完整 HTTP(S) 地址或显式设置 baseURL。应用不会读取历史登录令牌，也不会自动添加或刷新账户凭据。

## 创建服务实例

```typescript
import { createAxiosInstance } from '@renderer/common/http'

const service = createAxiosInstance({
  baseURL: 'https://api.example.com',
  timeout: 5000
})

const result = await service.get('/items')
```

如果服务需要认证，调用方应使用该服务自己的认证方式明确传入凭据。不得把一个服务的凭据附加到其他地址。

## 文件结构

- `request.ts`：实例工厂和请求方法。
- `interceptors.ts`：验证目标地址、规范化响应和错误。
- `config.ts`：超时等默认设置。
- `types.ts`：响应和分页类型。

本地功能通过 `window.api` 调用主进程，无需经过 HTTP。
