# Escarlet Local AI UI

Escarlet Local AI UI is a private, responsive web interface for discovering, loading, unloading, and chatting with models hosted by **LM Studio** and **Ollama** on the same Windows machine. The browser only talks to the Fastify backend; provider APIs remain bound to their local machine.

## Requirements

- Windows 10/11 (or Node.js LTS on another host)
- Node.js 20 LTS or newer
- LM Studio and/or Ollama installed locally (either provider may be offline)
- npm 10 or newer

## Install and run

```powershell
git clone https://github.com/brugiafredo/escarlet-local-ai-ui.git C:\Apps\escarlet-local-ai-ui
cd C:\Apps\escarlet-local-ai-ui
npm install
copy .env.example .env
npm run build
npm run start
```

For a manual launch, copy `.env.example` to `.env` once and adjust the provider URLs if needed. The Windows service installer creates `.env` automatically when it is missing and never overwrites an existing file. The `.env` file contains machine-specific configuration and is ignored by Git.

### Existing installations at the legacy path

An installation already running from `C:\Apps\local-ai-remote` remains compatible. **Do not move that directory while the WinSW service is installed.** First stop the `LocalAIRemote` service and uninstall its WinSW service definition; preserve `.env`, `data`, and `logs`; then move the project only if desired and reinstall the service with the new project path. GitHub redirects the previous repository URL after the rename, so updates can continue temporarily, but an administrator should keep the remote named `origin` and update it explicitly:

```powershell
cd C:\Apps\local-ai-remote
git remote set-url origin https://github.com/brugiafredo/escarlet-local-ai-ui.git
git remote -v
```

The update branch remains `master`, and existing `LocalAIRemote` service/executable/XML names are intentionally unchanged for compatibility.

Open [http://localhost:3000](http://localhost:3000). Production uses one Fastify port for both `/api/*` and the compiled Vue SPA.

The default `.env.example` URLs match the standard local provider ports:

```env
LM_STUDIO_URL=http://127.0.0.1:1234
OLLAMA_URL=http://127.0.0.1:11434
```

Change them if either provider uses a different local bind address. The app starts even if one or both providers are unavailable and shows each provider as offline.

## Development

```powershell
npm install
npm run dev
```

The Vue dev server runs on port 5173 and proxies `/api` to `VITE_SERVER_URL` when set, otherwise to `http://127.0.0.1:3000`. Set `VITE_API_URL` only when the browser should call a different API origin. Production leaves this value empty so the API is same-origin.

Checks:

```powershell
npm run typecheck
npm run test
npm run build
```

## Tailscale access

Install and sign in to Tailscale on the Windows host and on each client device. Find the Windows host's Tailscale IPv4 address with `tailscale ip -4`, then visit:

```text
http://TAILSCALE_IP:3000
```

For example: `http://100.106.130.118:3000`. The server listens on `0.0.0.0` by default so Tailscale can reach it, while LM Studio and Ollama remain configured against loopback URLs. No public tunnel or Internet-facing configuration is created by this project.

## Windows Firewall

Run PowerShell as Administrator and allow only the Escarlet Local AI UI port on the desired profiles:

```powershell
New-NetFirewallRule -DisplayName "Escarlet Local AI UI TCP 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

If the machine uses a stricter policy, scope the rule to the Tailscale interface or Tailscale address range. Review and remove it when no longer needed:

```powershell
Remove-NetFirewallRule -DisplayName "Escarlet Local AI UI TCP 3000"
```

The application never changes firewall rules automatically.

## Start automatically with WinSW

1. Build the application with `npm run build`.
2. Download the current WinSW x64 binary from the [WinSW releases page](https://github.com/winsw/winsw/releases), place it at `scripts\windows\LocalAIRemote.exe`, and keep the executable name exactly as shown.
3. From an elevated PowerShell prompt, run:

   ```powershell
   .\scripts\windows\install-service.ps1 -ProjectRoot "C:\Apps\escarlet-local-ai-ui"
   ```

The script first creates `C:\Apps\escarlet-local-ai-ui\.env` from `.env.example` **only when `.env` does not already exist**. Existing configuration is preserved; the script never overwrites it. It fails clearly if `.env.example` is missing. The script then creates `LocalAIRemote.xml`, installs the service with **Automatic** startup, starts it, and configures restart attempts after failures. The service launches `node apps/server/dist/index.js` with `C:\Apps\escarlet-local-ai-ui` as its working directory. Make sure `node` is available to the service account's PATH; an absolute Node path can be substituted in the generated XML if the Windows installation uses a per-user Node manager.

To remove the service without deleting the project:

```powershell
.\scripts\windows\uninstall-service.ps1
```

## Provider behavior

- LM Studio uses native `/api/v1/models`, `/api/v1/models/load`, `/api/v1/models/unload`, and `/api/v1/chat` named SSE. `/api/v0/models` is used only when the v1 model listing is unavailable with HTTP 404.
- Ollama uses `/api/tags`, `/api/ps`, and `/api/chat`. Loading keeps a model alive with `keep_alive: -1`; unloading sends `keep_alive: 0`.
- `/api/models` combines whichever providers respond. Offline providers do not prevent the remaining provider from being used.
- LM Studio models are identified using the current v1 `key` field. An unloaded LM Studio model can be sent a first chat request and LM Studio can auto-load it; Ollama models still use explicit keep-alive load/unload actions.
- Ollama and LM Studio model downloads and deletion are available from the Models page.
- Conversations are persisted server-side in `data/conversations.json` and mirrored to browser localStorage. Optional in-memory-session password authentication is controlled by `AUTH_ENABLED` and `AUTH_PASSWORD`.
- Remote updates and manual service restart are opt-in (`UPDATE_ENABLED=false` by default). The System page can run a fixed fast-forward-only pull, install, restart, and version check; after a successful action the page waits for the service and reloads with a cache-busting URL. WinSW receives a non-zero restart exit code; arbitrary shell commands are never accepted.
- The top bar and System page compare the Git commit embedded in the browser bundle with the commit reported by the running server. A mismatch means the browser is serving a stale bundle or the server was built from a different commit.
- The optional authenticated OpenCode bridge is documented in [`docs/opencode.md`](docs/opencode.md). It exposes `/v1/models` and `/v1/chat/completions` only when `OPENCODE_BRIDGE_ENABLED=true` and a dedicated bearer token is configured.
- All API errors use `{ error: true, code, message }` and production responses do not expose stack traces.

## MVP scope

Conversations, system prompts, and basic generation parameters are stored on the server and mirrored in browser `localStorage`. The PWA can be installed from a supported browser. Optional simple authentication, future sharing metadata, Ollama model management, and opt-in remote updates are included; databases, process control, RAG, agents, and public tunnels remain out of scope.
