/** Server entrypoint: wires config → store → chain → orchestrator → HTTP/WS app. */

import { loadConfig, wagerEnabled } from './config.js';
import { createAnchor, createSettlement } from './chain.js';
import { buildApp } from './app.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { createChainServices } from './token.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const levels = ['debug', 'info', 'warn', 'error', 'silent'];
  const threshold = levels.indexOf(config.logLevel);
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string, extra?: unknown): void => {
    if (levels.indexOf(level) < threshold) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    if (extra === undefined) console.log(line);
    else console.log(line, JSON.stringify(extra));
  };

  const store = new Store({ dataDir: config.dataDir, persist: config.persist });
  const anchor = createAnchor(config);
  const settlement = createSettlement(config);
  // Wallet-facing chain services: also the free-table token gate (FR-4, revised).
  const chainServices = createChainServices(config);
  const orchestrator = new Orchestrator({
    config,
    store,
    anchor,
    settlement,
    freeTableAccess: (wallet) => chainServices.requireFreeTableAccess(wallet),
    log,
  });
  orchestrator.init();
  // On-chain mode: agents deposit before seating, so the tables must exist first.
  await orchestrator.ensureTables();

  const { app, close } = await buildApp({ config, store, orchestrator, chainServices, log });
  orchestrator.start();

  const shutdown = async (signal: string): Promise<void> => {
    log('info', `received ${signal}, shutting down`);
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  log('info', `LLM Poker Arena listening on http://${config.host}:${config.port}`, {
    chainId: config.chainId,
    rngAnchor: anchor.kind,
    settlement: settlement.kind,
    wagerEnabled: wagerEnabled(config),
    freeTables: orchestrator.listTables().filter((t) => t.state.config.mode === 'FREE').length,
    wagerTables: orchestrator.listTables().filter((t) => t.state.config.mode === 'WAGER').length,
    dataDir: config.dataDir,
    freeGate: config.freeGateEnabled
      ? `on (>= ${config.tokenomics.freeGameMinTokens} ${config.tokenomics.tokenSymbol})`
      : 'off',
    walletServices: chainServices.available,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
