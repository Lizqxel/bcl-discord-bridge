import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { BridgeBot, StartRoundInput } from '../discord/bot.js';
import type { Logger } from '../logger.js';
import { dashboardHtml } from './page.js';

type SavedPick = { enabled: boolean; color: number };

// Keyed by Discord username so colors survive rounds and app restarts.
const PICKS_FILE = new URL('../../picks.json', import.meta.url);

export class DashboardServer {
  private server?: Server;
  private picks: Record<string, SavedPick> = DashboardServer.loadPicks();

  constructor(
    private readonly bot: BridgeBot,
    private readonly port: number,
    private readonly logger: Logger,
    private readonly onShutdown: () => Promise<void> = async () => undefined,
  ) {}

  async start(openBrowser = true): Promise<string> {
    if (this.server) return `http://127.0.0.1:${this.port}`;
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
    const url = `http://127.0.0.1:${this.port}`;
    this.logger.info({ url }, 'BCL dashboard ready');
    if (openBrowser) {
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], (error) => {
        if (error) this.logger.warn({ error, url }, 'Could not open dashboard browser');
      });
    }
    return url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server.closeAllConnections(); // the open dashboard tab keeps keep-alive sockets
    await closed;
  }

  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'");
    try {
      const origin = request.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${this.port}`) {
        throw new Error('この画面以外からの操作は拒否しました。');
      }
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(dashboardHtml);
        return;
      }
      if (request.method === 'GET' && request.url === '/api/state') {
        this.json(response, 200, this.bot.getSnapshot());
        return;
      }
      if (request.method === 'POST' && request.url === '/api/shutdown') {
        // Used by stop.cmd: ends rounds cleanly (members back, temp VCs deleted) before exit.
        this.json(response, 200, { ok: true });
        setImmediate(() => void this.onShutdown());
        return;
      }
      if (request.method === 'GET' && request.url === '/api/debug') {
        this.json(response, 200, this.bot.getDiagnostics());
        return;
      }
      if (request.method === 'GET' && request.url === '/api/picks') {
        this.json(response, 200, this.picks);
        return;
      }
      if (request.method === 'POST' && request.url === '/api/picks') {
        const input = await this.readJson<{ username?: string; enabled?: boolean; color?: number }>(request);
        if (!input.username || typeof input.username !== 'string' || input.username.length > 64) {
          throw new Error('ユーザー名が正しくありません。');
        }
        if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.color) || input.color! < 0 || input.color! > 17) {
          throw new Error('保存する色が正しくありません。');
        }
        this.picks[input.username] = { enabled: input.enabled, color: input.color! };
        writeFileSync(PICKS_FILE, JSON.stringify(this.picks, null, 2));
        this.json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/start') {
        const input = await this.readJson<StartRoundInput>(request);
        await this.bot.startRound(input);
        this.json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/recolor') {
        const input = await this.readJson<{ guildId?: string; userId?: string; colorId?: number }>(request);
        if (!input.guildId || !/^\d+$/.test(input.guildId) || !input.userId || !/^\d+$/.test(input.userId)) {
          throw new Error('Discordサーバーまたはメンバーが正しくありません。');
        }
        await this.bot.recolor(input.guildId, input.userId, Number(input.colorId));
        this.json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/stop') {
        const input = await this.readJson<{ guildId?: string }>(request);
        if (!input.guildId || !/^\d+$/.test(input.guildId)) throw new Error('Discordサーバーが正しくありません。');
        await this.bot.stopRound(input.guildId);
        this.json(response, 200, { ok: true });
        return;
      }
      this.json(response, 404, { error: 'Not found' });
    } catch (error) {
      this.logger.error({ error, path: request.url }, 'Dashboard request failed');
      this.json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private static loadPicks(): Record<string, SavedPick> {
    try {
      return JSON.parse(readFileSync(PICKS_FILE, 'utf8')) as Record<string, SavedPick>;
    } catch {
      return {};
    }
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString();
      if (body.length > 64_000) throw new Error('リクエストが大きすぎます。');
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error('入力を読み取れませんでした。');
    }
  }

  private json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }
}
