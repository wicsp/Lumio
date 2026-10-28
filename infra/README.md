# 部署

通常使用仓库根目录的 `install.sh`。macOS 用 launchd，Linux 用 systemd 用户服务；
手动安装分别见 [launchd](launchd/README.md)、[systemd](systemd/README.md)。
GitHub Releases 提供 macOS arm64、Linux x64/arm64 的独立程序，不需要 Bun。Docker / Nix 留到后续切片。

## Caddy 反向代理

服务器上运行 `lumio-hub setup --server`，对外地址填 `https://lumio.example.org`。
将域名指向服务器并按 Caddy 的要求开放 HTTPS 端口。示例 Caddyfile：

```caddyfile
lumio.example.org {
  reverse_proxy 127.0.0.1:7420
}
```

反向代理与 Hub 在同一台机器时，Hub 可只监听 `127.0.0.1:7420`。
监听地址和对外地址独立配置；直接使用非本机 HTTP 地址时会提示令牌明文传输的风险。
需要信任代理客户端 IP 时才配置 `LUMIO_TRUSTED_PROXY` 为代理的单个 IP。
