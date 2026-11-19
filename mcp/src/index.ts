import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { registerTools, type ToolSettings } from "./tools.js";

const VERSION = "0.1.0";
const BASE_MAINNET = "eip155:8453";

function money(value: string | undefined): string {
  const amount = (value ?? "5").replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error("TRONENERGYFROG_MAX_PAYMENT_USD must be a positive dollar amount, e.g. 5");
  }
  return `$${amount}`;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): ToolSettings {
  const maxPaymentUsd = money(env.TRONENERGYFROG_MAX_PAYMENT_USD);
  const settings: ToolSettings = {
    apiBase: env.TRONENERGYFROG_API_URL ?? "https://api.tronenergyfrog.com",
    siteBase: env.TRONENERGYFROG_SITE_URL ?? "https://tronenergyfrog.com",
    apiKey: env.TRONENERGYFROG_API_KEY?.trim() || undefined,
    timeoutMs: 20_000,
    fetch: globalThis.fetch,
    maxPaymentUsd,
  };
  const privateKey = env.TRONENERGYFROG_EVM_PRIVATE_KEY?.trim();
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("TRONENERGYFROG_EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
    }
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    // Only Base USDC is registered, and every payment is capped by the SDK's
    // spend controls before anything is signed.
    settings.payingFetch = wrapFetchWithPaymentFromConfig(globalThis.fetch, {
      schemes: [{ network: BASE_MAINNET, client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: maxPaymentUsd },
    });
    settings.decodePaymentResponse = decodePaymentResponseHeader;
  }
  return settings;
}

export function createServer(settings: ToolSettings): McpServer {
  const server = new McpServer(
    { name: "tronenergyfrog", version: VERSION },
    {
      instructions:
        "TronEnergyFrog rents TRON Energy so USDT TRC-20 transfers do not burn TRX. Energy goes to the wallet that SENDS the USDT. Use 65,000 Energy when the recipient already holds USDT and 130,000 when it does not. Always confirm address, amount and price with the user before a tool that spends money.",
    },
  );
  registerTools(server, settings);
  return server;
}
